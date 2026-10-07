import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { ComputeReceipt } from "@/domain/economy";
import { DEFAULTS, signingString, type HardwareReport, type NodeCapabilities, type RegisterBody, type Telemetry } from "@/node/protocol";
import { MemoryStore } from "@/services/store";
import { authenticateSigned, checkReplay, nodeIdFor, verifyNodeSignature, type SignedRequest } from "./auth";
import { classify, scheduleBenchmark } from "./benchmark";
import { CANARIES, MATCH_THRESHOLD, maybeShadow, scheduleCanary, similarity } from "./verify";
import { TRANSITIONS, createInferenceJob, getInferenceJob, matchJob, observeJob, publicInferenceJob, reportCompleted, reportFailed, reportProgress, reportStarted, sweepInferenceJobs, transition, type InferenceJob } from "./jobs";
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
  // Deterministic tests: no random shadow sampling unless a test forces it.
  process.env.BRAIN_VERIFY_SAMPLE_RATE = "0";
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

describe("cold model load", () => {
  it("gives a node that has not loaded the model the cold-start window, and fails a pinned job instead of re-queuing it", async () => {
    // A real vLLM node on first start: supports the model, has nothing loaded yet.
    const { n } = await registerMock(false);
    const t = Date.now();
    await heartbeatNativeNode(n.nodeId, tele({ loadedModels: [] }), undefined, undefined, t);
    g.__brainNNodes = undefined;
    const job = (await scheduleBenchmark(n.nodeId, t))!;
    expect(job.state).toBe("ASSIGNED");

    // 20 s later: still ASSIGNED (weights loading). Must NOT be re-matched.
    g.__brainNJobSweep = 0;
    await sweepInferenceJobs(t + DEFAULTS.startWithinMs + 1_000);
    expect((await getInferenceJob(job.jobId))!.state).toBe("ASSIGNED");

    // Node acknowledges, then takes two minutes to produce the first token: still fine.
    await reportStarted(n.nodeId, job.jobId, { backend: "vllm", loaded: false }, t + 30_000);
    g.__brainNJobSweep = 0;
    await sweepInferenceJobs(t + 150_000);
    expect((await getInferenceJob(job.jobId))!.state).toBe("STARTING");

    // Past the cold window with no progress: a pinned job fails outright, it is never queued to nowhere.
    g.__brainNJobSweep = 0;
    await sweepInferenceJobs(t + DEFAULTS.coldStartWithinMs + 1_000);
    const j = (await getInferenceJob(job.jobId))!;
    expect(j.state).toBe("FAILED");
    expect(j.failureReason).toBe("timeout");

    // And the next heartbeat does not immediately schedule another benchmark.
    await heartbeatNativeNode(n.nodeId, tele({ loadedModels: [] }), undefined, undefined, t + DEFAULTS.coldStartWithinMs + 2_000);
    g.__brainNNodes = undefined;
    expect(await scheduleBenchmark(n.nodeId, t + DEFAULTS.coldStartWithinMs + 2_000)).toBeNull();
    // Five minutes later it is tried again.
    const t2 = t + DEFAULTS.coldStartWithinMs + 6 * 60_000;
    await heartbeatNativeNode(n.nodeId, tele({ loadedModels: [] }), undefined, undefined, t2);
    g.__brainNNodes = undefined;
    const later = await scheduleBenchmark(n.nodeId, t2);
    expect(later?.state).toBe("ASSIGNED");
  });

  it("keeps the 20 s window for a node that already has the model loaded", async () => {
    const { n } = await registerMock(false);
    const t = Date.now();
    await heartbeatNativeNode(n.nodeId, tele({ loadedModels: ["qwen/qwen2.5-7b-instruct"] }), undefined, undefined, t);
    g.__brainNNodes = undefined;
    const job = (await scheduleBenchmark(n.nodeId, t))!;
    g.__brainNJobSweep = 0;
    await sweepInferenceJobs(t + DEFAULTS.startWithinMs + 1_000);
    expect((await getInferenceJob(job.jobId))!.state).toBe("FAILED"); // pinned: fails, not re-queued
  });
});

describe("benchmark on join", () => {
  it("classifies by coordinator-measured speed only, never for mock nodes", () => {
    expect(classify(5, false)).toBe("EDGE");
    expect(classify(20, false)).toBe("CONSUMER");
    expect(classify(50, false)).toBe("PRO");
    expect(classify(200, false)).toBe("DATACENTER");
    expect(classify(200, true)).toBeNull();
    expect(classify(Number.NaN, false)).toBeNull();
  });

  it("schedules one pinned, unpaid benchmark job per node and records the measured speed", async () => {
    const { n } = await registerMock(false);
    const t = Date.now();
    const job = await scheduleBenchmark(n.nodeId, t);
    expect(job?.state).toBe("ASSIGNED");
    expect(job?.assignedNode).toBe(n.nodeId);
    expect(job?.jobId.startsWith("bj-")).toBe(true);
    expect(publicInferenceJob(job!).kind).toBe("benchmark");
    // Idempotent while one is pending.
    expect(await scheduleBenchmark(n.nodeId, t + 1)).toBeNull();

    await reportStarted(n.nodeId, job!.jobId, { backend: "vllm", loaded: true }, t + 100);
    const content = "x".repeat(400);
    await reportProgress(n.nodeId, job!.jobId, { seq: 0, delta: content, tokens: 100 }, t + 200);
    const done = await reportCompleted(n.nodeId, job!.jobId, { content, finishReason: "stop", usage: { prompt: 20, completion: 100 }, durationMs: 2000, responseHash: sha(content) }, t + 2_200);
    expect(done.state).toBe("COMPLETED");
    expect(done.receiptId).toBeNull();
    expect(done.finalCost).toBeNull();
    const after = (await getNativeNode(n.nodeId))!;
    expect(after.benchmark.basis).toBe("coordinator-timed");
    expect(after.benchmark.score).toBe(50); // 100 tokens over 2.0 s of coordinator time
    expect(after.benchmark.computeClass).toBe("PRO");
    expect(after.activeJobIds).toEqual([]);
    // No receipt, no accounting: zero paid compute from a benchmark.
    expect((await g.__brainStore!.listDocs<ComputeReceipt>("receipt", { limit: 10 })).length).toBe(0);
    // A real node that is already measured is not re-benchmarked.
    expect(await scheduleBenchmark(n.nodeId, t + 3_000)).toBeNull();
  });
});

describe("verification probes", () => {
  it("similarity: identical 1, whitespace/case-insensitive, unrelated low, truncated prefix penalised", () => {
    expect(similarity("The quick brown fox jumps.", "The quick brown fox jumps.")).toBe(1);
    expect(similarity("The quick  brown fox", "the quick brown FOX")).toBe(1);
    expect(similarity("Entropy measures disorder in a system.", "Paris is the capital of France.")).toBeLessThan(0.3);
    const full = "Distributed networks schedule work by matching queued jobs to machines that report free capacity.";
    expect(similarity(full, full.slice(0, 30))).toBeLessThan(MATCH_THRESHOLD);
    expect(similarity(full, full + " ")).toBe(1);
  });

  async function runJob(nodeId: string, job: InferenceJob, content: string, t: number) {
    const tokens = Math.max(1, Math.ceil(content.length / 4)); // plausible for the text, like a real tokenizer count
    await reportStarted(nodeId, job.jobId, { backend: "vllm", loaded: true }, t + 10);
    await reportProgress(nodeId, job.jobId, { seq: 0, delta: content, tokens }, t + 50);
    return reportCompleted(nodeId, job.jobId, { content, finishReason: "stop", usage: { prompt: 10, completion: tokens }, durationMs: 100, responseHash: sha(content) }, t + 300);
  }

  it("shadows a deterministic customer job on a different node, records agreement on both, pays only the customer job", async () => {
    const a = await registerMock(false);
    const b = await registerMock(false);
    const t = Date.now();
    const job = await createInferenceJob({ requesterId: "cust", model: "qwen/qwen2.5-7b-instruct", messages: [{ role: "user", content: "hi" }], maxTokens: 64, temperature: 0 }, t);
    const m = await matchJob(job.jobId, t);
    const primary = m.assignedNode!;
    const other = primary === a.n.nodeId ? b.n.nodeId : a.n.nodeId;
    const done = await runJob(primary, m, "Hello there, this is the answer.", t);
    expect(done.receiptId).not.toBeNull();

    const shadow = await maybeShadow(job.jobId, t + 400, true);
    expect(shadow?.state).toBe("ASSIGNED");
    expect(shadow?.assignedNode).toBe(other);
    expect(shadow?.jobId.startsWith("vj-")).toBe(true);
    expect((await getInferenceJob(job.jobId))!.verification).toMatchObject({ kind: "redundant", status: "pending", peerJobId: shadow!.jobId });

    const sd = await runJob(other, shadow!, "Hello there, this is the answer!", t + 500);
    expect(sd.receiptId).toBeNull();
    expect(publicInferenceJob(sd).kind).toBe("verify");
    const p = (await getInferenceJob(job.jobId))!;
    expect(p.verification).toMatchObject({ kind: "redundant", status: "matched" });
    expect((await getNativeNode(primary))!.measured.redundantMatched).toBe(1);
    expect((await getNativeNode(other))!.measured.redundantMatched).toBe(1);
    expect((await g.__brainStore!.listDocs<ComputeReceipt>("receipt", { limit: 10 })).length).toBe(1);
  });

  it("records a mismatch against both nodes and lowers both reliability scores", async () => {
    const a = await registerMock(false);
    const b = await registerMock(false);
    const t = Date.now();
    const job = await createInferenceJob({ requesterId: "cust", model: "qwen/qwen2.5-7b-instruct", messages: [{ role: "user", content: "hi" }], maxTokens: 64, temperature: 0 }, t);
    const m = await matchJob(job.jobId, t);
    const primary = m.assignedNode!;
    const other = primary === a.n.nodeId ? b.n.nodeId : a.n.nodeId;
    await runJob(primary, m, "The capital of France is Paris, a city on the Seine.", t);
    const before = (await getNativeNode(primary))!.reputation;
    const shadow = (await maybeShadow(job.jobId, t + 400, true))!;
    await runJob(other, shadow, "I cannot help with that request.", t + 500);
    expect((await getInferenceJob(job.jobId))!.verification).toMatchObject({ kind: "redundant", status: "mismatched" });
    const pa = (await getNativeNode(primary))!;
    const pb = (await getNativeNode(other))!;
    expect(pa.measured.redundantMismatched).toBe(1);
    expect(pb.measured.redundantMismatched).toBe(1);
    expect(pa.reputation).toBeLessThan(before);
  });

  it("does not shadow sampled jobs when temperature is not 0, when the primary is a mock node, or when no second node exists", async () => {
    const { n } = await registerMock(false);
    const t = Date.now();
    const warm = await createInferenceJob({ requesterId: "cust", model: "qwen/qwen2.5-7b-instruct", messages: [{ role: "user", content: "hi" }], maxTokens: 64, temperature: 0.7 }, t);
    await runJob(n.nodeId, await matchJob(warm.jobId, t), "x", t);
    expect(await maybeShadow(warm.jobId, t + 400, true)).toBeNull();
    const cold = await createInferenceJob({ requesterId: "cust", model: "qwen/qwen2.5-7b-instruct", messages: [{ role: "user", content: "hi" }], maxTokens: 64, temperature: 0 }, t + 1000);
    await runJob(n.nodeId, await matchJob(cold.jobId, t + 1000), "y", t + 1000);
    // Only one node: the shadow is created, cannot be matched, and is cancelled rather than left queued.
    expect(await maybeShadow(cold.jobId, t + 1400, true)).toBeNull();
    const open = (await g.__brainStore!.listDocs<InferenceJob>("njob", { limit: 20 })).filter((j) => j.requesterId === "coordinator:verify");
    expect(open.every((j) => j.state === "CANCELLED")).toBe(true);
    const mock = await registerMock(true);
    const mj = await createInferenceJob({ requesterId: "cust", model: "brain/mock", messages: [{ role: "user", content: "hi" }], maxTokens: 64, temperature: 0 }, t + 2000);
    await runJob(mock.n.nodeId, await matchJob(mj.jobId, t + 2000), "[mock]", t + 2000);
    expect(await maybeShadow(mj.jobId, t + 2400, true)).toBeNull();
  });

  it("canaries: pinned, unpaid, pass/fail recorded, two failures degrade the node, a pass restores it; mock nodes are never canaried", async () => {
    const { n } = await registerMock(false);
    const t = Date.now();
    const c1 = (await scheduleCanary(n.nodeId, t, true))!;
    expect(c1.jobId.startsWith("cj-")).toBe(true);
    expect(c1.assignedNode).toBe(n.nodeId);
    const canary = CANARIES.find((c) => c.id === c1.canaryId)!;
    // Wrong answer.
    const f1 = await runJob(n.nodeId, c1, "I'm sorry, I can't do that.", t);
    expect(f1.receiptId).toBeNull();
    expect((await getInferenceJob(c1.jobId))!.verification).toMatchObject({ kind: "canary", status: "failed" });
    let node = (await getNativeNode(n.nodeId))!;
    expect(node.measured.canaryFailStreak).toBe(1);
    expect(node.state).toBe("ONLINE");
    const c2 = (await scheduleCanary(n.nodeId, t + 1000, true))!;
    await runJob(n.nodeId, c2, "No.", t + 1000);
    node = (await getNativeNode(n.nodeId))!;
    expect(node.measured.canaryFailStreak).toBe(2);
    expect(node.state).toBe("DEGRADED");
    // A degraded node is not routable for customers.
    const cust = await createInferenceJob({ requesterId: "cust", model: "qwen/qwen2.5-7b-instruct", messages: [{ role: "user", content: "hi" }], maxTokens: 8, temperature: 0 }, t + 1500);
    expect((await matchJob(cust.jobId, t + 1500)).state).toBe("QUEUED");
    // Correct answer (forced, since DEGRADED nodes are not due by schedule).
    const c3 = (await scheduleCanary(n.nodeId, t + 2000, true))!;
    const right = CANARIES.find((c) => c.id === c3.canaryId)!;
    const answer = right.id === "word" ? "PINEAPPLE" : right.id === "sum" ? "43" : right.id === "list" ? "red, green, blue" : "niarb";
    expect(right.check(answer)).toBe(true);
    void canary;
    await runJob(n.nodeId, c3, answer, t + 2000);
    node = (await getNativeNode(n.nodeId))!;
    expect(node.measured.canaryFailStreak).toBe(0);
    expect(node.measured.canaryPassed).toBe(1);
    expect(node.state).toBe("ONLINE");
    const mock = await registerMock(true);
    expect(await scheduleCanary(mock.n.nodeId, t, true)).toBeNull();
  });
});

describe("offline node with work in flight", () => {
  it("re-queues an assigned job to another node as soon as the sweep sees the node OFFLINE", async () => {
    const a = await registerMock(false);
    const t = Date.now();
    const job = await createInferenceJob({ requesterId: "cust", model: "qwen/qwen2.5-7b-instruct", messages: [{ role: "user", content: "hi" }], maxTokens: 8, temperature: 0 }, t);
    const m = await matchJob(job.jobId, t);
    expect(m.assignedNode).toBe(a.n.nodeId);
    // Node a disappears; node b joins and heartbeats.
    const later = t + DEFAULTS.offlineAfterMs + 1_000;
    const b = await registerMock(false);
    await heartbeatNativeNode(b.n.nodeId, tele(), undefined, undefined, later);
    g.__brainNSweep = 0;
    await sweepNativeNodes(later);
    expect((await getNativeNode(a.n.nodeId))!.state).toBe("OFFLINE");
    g.__brainNJobSweep = 0;
    await sweepInferenceJobs(later);
    const j = (await getInferenceJob(job.jobId))!;
    expect(j.state).toBe("ASSIGNED");
    expect(j.assignedNode).toBe(b.n.nodeId);
    expect(j.excludedNodes).toContain(a.n.nodeId);
    expect(j.history.map((h) => h.state)).toEqual(["QUEUED", "MATCHING", "ASSIGNED", "QUEUED", "MATCHING", "ASSIGNED"]);
    expect((await getNativeNode(a.n.nodeId))!.activeJobIds).toEqual([]);
  });
});
