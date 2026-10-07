import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { HardwareReport, NodeCapabilities, RegisterBody } from "@/node/protocol";
import { epochAt, epochLengthMs, measureWork, settleEpoch } from "@/services/settlement";
import { MemoryStore } from "@/services/store";
import { nodeIdFor } from "./auth";
import { scheduleBenchmark } from "./benchmark";
import { createInferenceJob, matchJob, reportCompleted, reportFailed, reportStarted, type InferenceJob } from "./jobs";
import { getNativeNode, linkNativeWallet, registerNativeNode, updateNativeNode } from "./registry";
import { maybeShadow } from "./verify";
import { nativeComputeUnits, paramCount } from "./work";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore; __brainNNodes?: unknown; __brainSettleAt?: number };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const store = () => g.__brainStore!;
const MODEL = "qwen/qwen2.5-7b-instruct";
const WALLET_A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const WALLET_B = "9yQNvWqGh3Wn6UNcYvD6K6Z4iw3KTxRRwSvd8ZJyyBbL";

const hw = (mock: boolean): HardwareReport => ({ os: { platform: "linux", release: "6", arch: "x64" }, cpu: { model: "t", cores: 8 }, ramTotalMb: 32_000, ramFreeMb: 16_000, diskFreeGb: 100, gpus: [{ index: 0, model: mock ? "Mock GPU" : "RTX 4090", vramTotalMb: 24_576, vramUsedMb: 0, utilizationPct: 0, temperatureC: 40, powerW: 30, driverVersion: null, cudaVersion: mock ? null : "12.4", source: mock ? "mock" : "nvidia-smi" }], cuda: !mock, mock });
const caps = (models: string[]): NodeCapabilities => ({ backend: "mock", supportedModels: models, loadedModels: models, maxConcurrency: 1, region: null, askUsdPer1MTokens: null });

async function registerNode(opts: { mock?: boolean; wallet?: string; benchmarked?: boolean } = {}) {
  const { publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pub = spki.subarray(spki.length - 32).toString("base64");
  const mock = opts.mock ?? false;
  const body: RegisterBody = { protocol: 1, nodeId: nodeIdFor(pub), publicKey: pub, agentVersion: "t", hardware: hw(mock), capabilities: caps(mock ? ["brain/mock"] : [MODEL]), wallet: opts.wallet };
  let n = await registerNativeNode(body, "ip");
  if (opts.benchmarked ?? !mock) {
    n = (await updateNativeNode(n.nodeId, (x) => void (x.benchmark = { score: 30, computeClass: "CONSUMER", basis: "coordinator-timed", at: Date.now() })))!;
    g.__brainNNodes = undefined;
  }
  return n;
}

async function customerJob(t: number, model = MODEL) {
  const job = await createInferenceJob({ requesterId: "cust", model, messages: [{ role: "user", content: "Say hello in one sentence." }], maxTokens: 64, temperature: 0 }, t);
  return matchJob(job.jobId, t);
}

async function complete(nodeId: string, job: InferenceJob, content: string, t: number) {
  const tokens = Math.max(1, Math.ceil(content.length / 4));
  await reportStarted(nodeId, job.jobId, { backend: "vllm", loaded: true }, t + 10);
  return reportCompleted(nodeId, job.jobId, { content, finishReason: "stop", usage: { prompt: 8, completion: tokens }, durationMs: 100, responseHash: sha(content) }, t + 300);
}

beforeEach(() => {
  process.env.BRAIN_VERIFY_SAMPLE_RATE = "0";
  process.env.BRAIN_EPOCH_MINUTES = "60";
  g.__brainStore = new MemoryStore();
  g.__brainNNodes = undefined;
  g.__brainSettleAt = 0;
});

describe("compute units", () => {
  it("parses parameter counts", () => {
    expect(paramCount("1.5B")).toBe(1.5e9);
    expect(paramCount("7B")).toBe(7e9);
    expect(paramCount("0")).toBe(0);
    expect(paramCount("nonsense")).toBe(0);
  });

  it("uses the network's LLM unit (params × tokens / 2^20) and bounds node-reported tokens by text the coordinator saw", () => {
    const base = { jobId: "j", requesterId: "cust", model: MODEL, assignedNode: "N-1", createdAt: 0, request: { messages: [{ content: "x".repeat(40) }] }, output: "y".repeat(200) };
    expect(nativeComputeUnits({ ...base, tokenUsage: { prompt: 10, completion: 50 } })).toBe(Math.round((7e9 * 60) / 1_048_576));
    // Claims beyond the text are clipped, not trusted.
    expect(nativeComputeUnits({ ...base, tokenUsage: { prompt: 10_000, completion: 10_000 } })).toBe(Math.round((7e9 * (56 + 216)) / 1_048_576));
    expect(nativeComputeUnits({ ...base, model: "brain/mock", tokenUsage: { prompt: 10, completion: 50 } })).toBe(0);
    expect(nativeComputeUnits({ ...base, tokenUsage: null })).toBe(0);
  });
});

describe("native work enters settlement", () => {
  it("records a completed customer job as verified work; probes record nothing", async () => {
    const n = await registerNode({ wallet: WALLET_A });
    const t = Date.now();
    const job = await customerJob(t);
    expect(job.assignedNode).toBe(n.nodeId);
    const done = await complete(n.nodeId, job, "Hello there, nice to meet you today.", t);
    expect(done.state).toBe("COMPLETED");
    const w = (await store().getWork(job.jobId))!;
    expect(w).toMatchObject({ source: "native-inference", assignedTo: n.nodeId, status: "completed", verified: true, model: MODEL, submittedAt: t });
    expect(w.computeUnits).toBe(nativeComputeUnits(done));
    expect(w.computeUnits).toBeGreaterThan(0);

    // A benchmark probe on the same node completes but is not work.
    const unb = await registerNode({ wallet: WALLET_B, benchmarked: false });
    const bj = (await scheduleBenchmark(unb.nodeId, t + 1000))!;
    const bdone = await complete(unb.nodeId, bj, "one two three four five six seven eight nine ten", t + 1000);
    expect(bdone.state).toBe("COMPLETED");
    expect(await store().getWork(bj.jobId)).toBeNull();
    const agg = await store().aggregateWork(t - 1, t + 10_000, 60_000);
    expect(agg.map((a) => a.nodeId)).toEqual([n.nodeId]);
  });

  it("records failures with settlement's lost-unit reasons, and mock models never produce work", async () => {
    const n = await registerNode({ wallet: WALLET_A });
    const t = Date.now();
    const job = await customerJob(t);
    await reportStarted(n.nodeId, job.jobId, { backend: "vllm", loaded: true }, t + 10);
    await reportFailed(n.nodeId, job.jobId, { reason: "timeout", detail: "" }, t + 500);
    expect(await store().getWork(job.jobId)).toMatchObject({ status: "failed", verified: false, failReason: "deadline", computeUnits: 0 });

    const mock = await registerNode({ mock: true, wallet: WALLET_B });
    const mj = await customerJob(t + 1000, "brain/mock");
    expect(mj.assignedNode).toBe(mock.nodeId);
    await complete(mock.nodeId, mj, "mock output text here", t + 1000);
    expect(await store().getWork(mj.jobId)).toBeNull();
  });

  it("a shadow mismatch turns the primary's record into an unpaid disputed unit", async () => {
    const a = await registerNode({ wallet: WALLET_A });
    const b = await registerNode({ wallet: WALLET_B });
    const t = Date.now();
    const job = await customerJob(t);
    const primary = job.assignedNode!;
    const other = primary === a.nodeId ? b.nodeId : a.nodeId;
    await complete(primary, job, "The capital of France is Paris, a city on the Seine.", t);
    expect((await store().getWork(job.jobId))!.verified).toBe(true);
    const shadow = (await maybeShadow(job.jobId, t + 400, true))!;
    await complete(other, shadow, "I cannot help with that request.", t + 500);
    expect(await store().getWork(job.jobId)).toMatchObject({ status: "failed", verified: false, failReason: "replica-dispute", computeUnits: 0 });
    expect(await store().getWork(shadow.jobId)).toBeNull();
  });
});

describe("wallet verification gates pay", () => {
  it("links only when the node-reported wallet and the signed wallet agree", async () => {
    const n = await registerNode({ wallet: WALLET_A });
    expect(n.wallet).toEqual({ address: WALLET_A, verified: false });
    await expect(linkNativeWallet(n.nodeId, WALLET_B)).rejects.toThrow("wallet_mismatch");
    await expect(linkNativeWallet("N-NOPE", WALLET_A)).rejects.toThrow("not_found");
    const linked = await linkNativeWallet(n.nodeId, WALLET_A);
    expect(linked.wallet).toEqual({ address: WALLET_A, verified: true });
    const none = await registerNode({});
    await expect(linkNativeWallet(none.nodeId, WALLET_A)).rejects.toThrow("wallet_mismatch");
  });

  it("unverified wallets accrue nothing; verified ones get their compute share of the epoch", async () => {
    const len = epochLengthMs();
    const t0 = epochAt(Date.now() - len).startsAt; // last closed epoch
    const paid = await registerNode({ wallet: WALLET_A });
    await linkNativeWallet(paid.nodeId, WALLET_A);
    const unpaid = await registerNode({ wallet: WALLET_B });
    g.__brainNNodes = undefined;

    // One job each; the router picks, so pin by excluding the other node.
    for (const n of [paid, unpaid]) {
      const job = await createInferenceJob({ requesterId: "cust", model: MODEL, messages: [{ role: "user", content: "Say hello in one sentence." }], maxTokens: 64, temperature: 0, pinnedNode: n.nodeId }, t0 + 1000);
      const m = await matchJob(job.jobId, t0 + 1000);
      expect(m.assignedNode).toBe(n.nodeId);
      await complete(n.nodeId, m, "Hello there, nice to meet you today.", t0 + 1000);
    }

    const { wallets, networkVerifiedCompute } = await measureWork(t0, t0 + len);
    expect(networkVerifiedCompute).toBeGreaterThan(0);
    expect(wallets.map((w) => w.wallet)).toEqual([WALLET_A]);
    expect(wallets[0].verifiedCompute).toBe(networkVerifiedCompute / 2);
    expect(wallets[0].nodes[0]).toMatchObject({ id: paid.nodeId, walletVerified: true, deviceClass: "CONSUMER" });
    expect(wallets[0].nodes[0].reputation).toBeGreaterThan(0);
    expect(wallets[0].nodes[0].reputation).toBeLessThanOrEqual(1);

    const { epoch } = await settleEpoch({ epochStart: t0, poolLamports: 1_000_000_000 });
    expect(epoch.participants).toBe(1);
    const allocs = await store().allocationsForEpoch(epoch.id);
    expect(allocs).toHaveLength(1);
    expect(allocs[0].wallet).toBe(WALLET_A);
    expect(allocs[0].lamports).toBeGreaterThan(0);
    expect(await getNativeNode(unpaid.nodeId)).not.toBeNull();
  });
});
