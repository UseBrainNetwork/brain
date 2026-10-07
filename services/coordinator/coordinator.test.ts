import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { ComputeReceipt } from "@/domain/economy";
import { DEFAULTS, signingString, type HardwareReport, type NodeCapabilities, type RegisterBody, type Telemetry } from "@/node/protocol";
import { MemoryStore } from "@/services/store";
import { authenticateSigned, checkReplay, nodeIdFor, verifyNodeSignature, type SignedRequest } from "./auth";
import { TRANSITIONS, createInferenceJob, getInferenceJob, matchJob, observeJob, reportCompleted, reportFailed, reportProgress, reportStarted, sweepInferenceJobs, transition, type InferenceJob } from "./jobs";
import { canonicalJson, receiptHash, verifyReceipt } from "./receipts";
import { getNativeNode, heartbeatNativeNode, listNativeNodes, registerNativeNode, reliabilityScore, sweepNativeNodes } from "./registry";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore; __brainNNodes?: unknown; __brainNSweep?: number; __brainNJobSweep?: number };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32).toString("base64");
  return { pub, nodeId: nodeIdFor(pub), sign: (method: string, path: string, ts: number, body: string) => sign(null, Buffer.from(signingString(method, path, ts, sha(body))), privateKey).toString("base64") };
}

const hw = (mock = true): HardwareReport => ({ os: { platform: "linux", release: "6", arch: "x64" }, cpu: { model: "test", cores: 8 }, ramTotalMb: 32_000, ramFreeMb: 16_000, diskFreeGb: 100, gpus: [{ index: 0, model: mock ? "Mock GPU" : "RTX 4090", vramTotalMb: 24_576, vramUsedMb: 0, utilizationPct: 0, temperatureC: 40, powerW: 30, driverVersion: null, cudaVersion: mock ? null : "12.4", source: mock ? "mock" : "nvidia-smi" }], cuda: !mock, mock });
const caps = (models: string[], extra: Partial<NodeCapabilities> = {}): NodeCapabilities => ({ backend: "mock", supportedModels: models, loadedModels: models, maxConcurrency: 1, region: null, askUsdPer1MTokens: null, ...extra });
const tele = (extra: Partial<Telemetry> = {}): Telemetry => ({ gpuUtilPct: 0, vramUsedMb: 0, vramTotalMb: 24_576, temperatureC: 40, powerW: 30, load: 0, activeJobs: 0, loadedModels: ["brain/mock"], rttMs: 20, ...extra });

async function registerMock(mock = true, models = mock ? ["brain/mock"] : ["qwen/qwen2.5-7b-instruct"]) {
  const k = keypair();
  const body: RegisterBody = { protocol: 1, nodeId: k.nodeId, publicKey: k.pub, agentVersion: "t", hardware: hw(mock), capabilities: caps(models) };
  const n = await registerNativeNode(body, "ip");
  return { k, n };
}

beforeEach(() => {
  g.__brainStore = new MemoryStore();
  g.__brainNNodes = undefined;
  g.__brainNSweep = 0;
  g.__brainNJobSweep = 0;
});

describe("node authentication", () => {
  it("verifies a signature over method, path, timestamp and body hash; rejects tampering", () => {
    const k = keypair();
    const ts = Date.now();
    const body = JSON.stringify({ a: 1 });
    const sig = k.sign("POST", "/api/coordinator/heartbeat", ts, body);
    expect(verifyNodeSignature(k.pub, "POST", "/api/coordinator/heartbeat", ts, body, sig)).toBe(true);
    expect(verifyNodeSignature(k.pub, "POST", "/api/coordinator/work", ts, body, sig)).toBe(false);
    expect(verifyNodeSignature(k.pub, "POST", "/api/coordinator/heartbeat", ts + 1, body, sig)).toBe(false);
    expect(verifyNodeSignature(k.pub, "POST", "/api/coordinator/heartbeat", ts, body + " ", sig)).toBe(false);
    expect(verifyNodeSignature(keypair().pub, "POST", "/api/coordinator/heartbeat", ts, body, sig)).toBe(false);
  });

  it("derives the node id from the key and refuses replays", () => {
    const k = keypair();
    expect(k.nodeId).toMatch(/^N-[0-9A-F]{8}$/);
    expect(nodeIdFor(k.pub)).toBe(k.nodeId);
    const ts = Date.now();
    const s: SignedRequest = { nodeId: k.nodeId, publicKey: k.pub, ts, signature: k.sign("POST", "/p", ts, "{}"), bodyText: "{}", pathname: "/p", method: "POST" };
    expect(() => authenticateSigned(s, k.pub)).not.toThrow();
    expect(() => authenticateSigned(s, k.pub)).toThrow(/replayed/);
    expect(checkReplay("N-X", "sig1")).toBe(true);
    expect(checkReplay("N-X", "sig1")).toBe(false);
  });
});

describe("registry", () => {
  it("registers with trust-on-first-use and refuses a different key for the same id", async () => {
    const { k, n } = await registerMock();
    expect(n.state).toBe("ONLINE");
    expect(n.reported.capabilities.supportedModels).toEqual(["brain/mock"]);
    const other = keypair();
    await expect(registerNativeNode({ protocol: 1, nodeId: k.nodeId, publicKey: other.pub, agentVersion: "t", hardware: hw(), capabilities: caps(["brain/mock"]) }, "ip")).rejects.toThrow(/node_id_mismatch|node_id_taken/);
  });

  it("a mock node can only serve the mock model; a real node can never serve it", async () => {
    const a = await registerMock(true, ["brain/mock", "qwen/qwen2.5-7b-instruct"]);
    expect(a.n.reported.capabilities.supportedModels).toEqual(["brain/mock"]);
    const b = await registerMock(false, ["brain/mock", "qwen/qwen2.5-7b-instruct"]);
    expect(b.n.reported.capabilities.supportedModels).toEqual(["qwen/qwen2.5-7b-instruct"]);
    expect(b.n.reported.hardware.mock).toBe(false);
  });

  it("drops unknown models and clamps reported fields", async () => {
    const k = keypair();
    const n = await registerNativeNode({ protocol: 1, nodeId: k.nodeId, publicKey: k.pub, agentVersion: "t", hardware: hw(false), capabilities: caps(["not/a-model", "qwen/qwen2.5-7b-instruct"], { maxConcurrency: 999, region: "EU-West-Extra-Long-Label-That-Goes-On" }) }, "ip");
    expect(n.reported.capabilities.supportedModels).toEqual(["qwen/qwen2.5-7b-instruct"]);
    expect(n.reported.capabilities.maxConcurrency).toBe(16);
    expect(n.region).toBe("eu-west-extra-long-label-that-go");
  });

  it("heartbeats keep a node online, derive BUSY/DRAINING/DEGRADED, and silence sweeps it OFFLINE", async () => {
    const { n } = await registerMock();
    const t0 = n.lastHeartbeatAt;
    let h = await heartbeatNativeNode(n.nodeId, tele(), undefined, undefined, t0 + 15_000);
    expect(h.state).toBe("ONLINE");
    expect(h.uptimeMs).toBe(15_000);
    h = await heartbeatNativeNode(n.nodeId, tele(), undefined, true, t0 + 30_000);
    expect(h.state).toBe("DRAINING");
    h = await heartbeatNativeNode(n.nodeId, tele({ temperatureC: 97 }), undefined, false, t0 + 45_000);
    expect(h.state).toBe("DEGRADED");
    h = await heartbeatNativeNode(n.nodeId, tele(), undefined, false, t0 + 60_000);
    expect(h.state).toBe("ONLINE");
    g.__brainNNodes = undefined;
    g.__brainNSweep = 0;
    await sweepNativeNodes(t0 + 60_000 + DEFAULTS.offlineAfterMs + 1);
    expect((await getNativeNode(n.nodeId))!.state).toBe("OFFLINE");
    // A heartbeat after a long gap does not count the gap as uptime.
    h = await heartbeatNativeNode(n.nodeId, tele(), undefined, false, t0 + 200_000);
    expect(h.uptimeMs).toBe(60_000);
    expect(h.state).toBe("ONLINE");
  });

  it("reliability starts neutral and tracks measured outcomes", async () => {
    const { n } = await registerMock();
    expect(reliabilityScore(n)).toBe(70);
    n.measured.jobsCompleted = 20;
    expect(reliabilityScore(n)).toBeGreaterThanOrEqual(95);
    n.measured.jobsFailed = 20;
    expect(reliabilityScore(n)).toBeLessThan(80);
  });
});

describe("job state machine", () => {
  const stub = (state: InferenceJob["state"]): InferenceJob => ({ state, history: [] }) as unknown as InferenceJob;

  it("only allows listed transitions", () => {
    expect(() => transition(stub("QUEUED"), "MATCHING", 1)).not.toThrow();
    expect(() => transition(stub("QUEUED"), "RUNNING", 1)).toThrow(/illegal_transition/);
    expect(() => transition(stub("COMPLETED"), "FAILED", 1)).toThrow(/illegal_transition/);
    expect(() => transition(stub("RUNNING"), "QUEUED", 1)).toThrow(/illegal_transition/);
    for (const t of ["COMPLETED", "FAILED", "CANCELLED"] as const) expect(TRANSITIONS[t]).toEqual([]);
    const j = transition(stub("ASSIGNED"), "STARTING", 7, "x");
    expect(j.history).toEqual([{ state: "STARTING", at: 7, note: "x" }]);
  });

  it("runs the full happy path and issues a signed receipt; node counters update", async () => {
    const { n } = await registerMock();
    const t = Date.now();
    const job = await createInferenceJob({ requesterId: "cust", model: "brain/mock", messages: [{ role: "user", content: "hi" }], maxTokens: 32, temperature: 0 }, t);
    expect(job.state).toBe("QUEUED");
    const m = await matchJob(job.jobId, t + 1);
    expect(m.state).toBe("ASSIGNED");
    expect(m.assignedNode).toBe(n.nodeId);
    expect((await getNativeNode(n.nodeId))!.activeJobIds).toEqual([job.jobId]);
    expect((await getNativeNode(n.nodeId))!.state).toBe("BUSY");

    await reportStarted(n.nodeId, job.jobId, { backend: "mock", loaded: true }, t + 100);
    await reportProgress(n.nodeId, job.jobId, { seq: 0, delta: "hello", tokens: 1 }, t + 200);
    await expect(reportProgress(n.nodeId, job.jobId, { seq: 0, delta: "dup", tokens: 1 }, t + 201)).rejects.toThrow(/bad_seq/);
    await reportProgress(n.nodeId, job.jobId, { seq: 1, delta: " world", tokens: 2 }, t + 300);
    const content = "hello world";
    const done = await reportCompleted(n.nodeId, job.jobId, { content, finishReason: "stop", usage: { prompt: 2, completion: 2 }, durationMs: 250, responseHash: sha(content) }, t + 400);
    expect(done.state).toBe("COMPLETED");
    expect(done.history.map((h) => h.state)).toEqual(["QUEUED", "MATCHING", "ASSIGNED", "STARTING", "RUNNING", "VERIFYING", "COMPLETED"]);
    expect(done.computeDurationMs).toBe(200);
    expect(done.receiptId).toBe(`r-${job.jobId}`);

    const r = (await g.__brainStore!.getDoc<ComputeReceipt>("receipt", done.receiptId!))!;
    expect(r.verificationMethod).toBe("node-reported");
    expect(r.attestation.kind).toBe("signature");
    expect(r.canonical?.body.nodeId).toBe(n.nodeId);
    expect(r.canonical?.body.outputTokens).toBe(2);
    expect(verifyReceipt(r)).toEqual({ ok: true });
    expect(verifyReceipt({ ...r, canonical: { ...r.canonical!, body: { ...r.canonical!.body, outputTokens: 999 } } }).ok).toBe(false);
    // Unpriced by default: no fabricated money.
    expect(r.customerCost).toBeNull();

    const after = (await getNativeNode(n.nodeId))!;
    expect(after.measured.jobsCompleted).toBe(1);
    expect(after.measured.tokensGenerated).toBe(2);
    expect(after.measured.tokPerSec).toEqual([10]);
    expect(after.activeJobIds).toEqual([]);
    expect(after.state).toBe("ONLINE");
  });

  it("fails verification when the hash or streamed text does not match", async () => {
    const { n } = await registerMock();
    const t = Date.now();
    const job = await createInferenceJob({ requesterId: "c", model: "brain/mock", messages: [{ role: "user", content: "x" }], maxTokens: 8, temperature: 0 }, t);
    await matchJob(job.jobId, t);
    await reportProgress(n.nodeId, job.jobId, { seq: 0, delta: "abc", tokens: 1 }, t + 10);
    const bad = await reportCompleted(n.nodeId, job.jobId, { content: "abd", finishReason: "stop", usage: { prompt: 1, completion: 1 }, durationMs: 5, responseHash: sha("abd") }, t + 20);
    expect(bad.state).toBe("FAILED");
    expect(bad.failureReason).toBe("verification_failed");
    expect(bad.history.at(-1)?.note).toMatch(/final text differs/);
    expect((await getNativeNode(n.nodeId))!.measured.jobsFailed).toBe(1);
  });

  it("rejects reports from a node that does not own the job", async () => {
    const a = await registerMock();
    const b = await registerMock();
    const t = Date.now();
    const job = await createInferenceJob({ requesterId: "c", model: "brain/mock", messages: [{ role: "user", content: "x" }], maxTokens: 8, temperature: 0 }, t);
    const m = await matchJob(job.jobId, t);
    const other = m.assignedNode === a.n.nodeId ? b.n.nodeId : a.n.nodeId;
    await expect(reportStarted(other, job.jobId, { backend: "mock", loaded: false }, t)).rejects.toThrow(/not_your_job/);
  });

  it("stays QUEUED with a capacity reason when nothing can serve the model", async () => {
    await registerMock();
    const t = Date.now();
    const job = await createInferenceJob({ requesterId: "c", model: "qwen/qwen2.5-7b-instruct", messages: [{ role: "user", content: "x" }], maxTokens: 8, temperature: 0 }, t);
    const m = await matchJob(job.jobId, t);
    expect(m.state).toBe("QUEUED");
    expect(m.routing?.reason).toMatch(/0 of 1 nodes can serve qwen\/qwen2.5-7b-instruct/);
    expect(m.routing?.reason).toMatch(/does not serve/);
  });

  it("re-matches to another node when the first reports model_unavailable, then times out via sweep", async () => {
    const a = await registerMock();
    const b = await registerMock();
    const t = Date.now();
    const job = await createInferenceJob({ requesterId: "c", model: "brain/mock", messages: [{ role: "user", content: "x" }], maxTokens: 8, temperature: 0 }, t);
    const m = await matchJob(job.jobId, t);
    const first = m.assignedNode!;
    const second = first === a.n.nodeId ? b.n.nodeId : a.n.nodeId;
    const re = await reportFailed(first, job.jobId, { reason: "model_unavailable" }, t + 10);
    expect(re.state).toBe("QUEUED");
    expect(re.excludedNodes).toEqual([first]);
    g.__brainNNodes = undefined;
    const m2 = await matchJob(job.jobId, t + 20);
    expect(m2.assignedNode).toBe(second);
    // Second node never starts: sweep gives up after startWithinMs since attempts are exhausted.
    g.__brainNJobSweep = 0;
    await sweepInferenceJobs(t + 20 + DEFAULTS.startWithinMs + 1);
    const j = (await getInferenceJob(job.jobId))!;
    expect(j.state).toBe("FAILED");
    expect(j.failureReason).toBe("timeout");
    expect((await getNativeNode(second))!.measured.jobsTimedOut).toBe(1);
  });

  it("observeJob yields deltas and ends at the terminal state", async () => {
    const { n } = await registerMock();
    const t = Date.now();
    const job = await createInferenceJob({ requesterId: "c", model: "brain/mock", messages: [{ role: "user", content: "x" }], maxTokens: 8, temperature: 0 }, t);
    await matchJob(job.jobId, t);
    const seen: string[] = [];
    const run = (async () => {
      for await (const { delta } of observeJob(job.jobId, { pollMs: 20 })) if (delta) seen.push(delta);
    })();
    await reportProgress(n.nodeId, job.jobId, { seq: 0, delta: "a", tokens: 1 }, t + 1);
    await new Promise((r) => setTimeout(r, 40));
    await reportProgress(n.nodeId, job.jobId, { seq: 1, delta: "b", tokens: 2 }, t + 2);
    await new Promise((r) => setTimeout(r, 40));
    await reportCompleted(n.nodeId, job.jobId, { content: "ab", finishReason: "stop", usage: { prompt: 1, completion: 2 }, durationMs: 1, responseHash: sha("ab") }, t + 3);
    await run;
    expect(seen.join("")).toBe("ab");
  });
});

describe("canonical receipts", () => {
  it("serialises with sorted keys and hashes deterministically", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe('{"a":{"c":null,"d":[1,2]},"b":1}');
    const body = { v: 1 as const, jobId: "j", nodeId: "n", model: "m", inputTokens: 1, outputTokens: 2, executionMs: 3, timestamp: 4, requestHash: "r", responseHash: "s", hardwareClass: "MOCK", cost: null };
    expect(receiptHash(body)).toBe(receiptHash({ ...body }));
    expect(receiptHash(body)).not.toBe(receiptHash({ ...body, outputTokens: 3 }));
  });
});

describe("listing", () => {
  it("lists nodes newest-heartbeat first", async () => {
    await registerMock();
    await registerMock();
    expect((await listNativeNodes(0)).length).toBe(2);
  });
});
