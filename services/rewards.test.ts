import { generateKeyPairSync, sign } from "node:crypto";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RewardAllocation, RewardEpoch } from "@/domain/types";
import { balanceOf, claim, issueClaim, payoutStatus, setPayoutSender } from "./claims";
import type { PayoutSender } from "./payouts";
import { keyFromSecret, signedTransfer, transferMessage } from "./payouts";
import { rewardsSummary } from "./rewardsSummary";
import { epochAt, epochLengthMs, measureWork, settleEpoch } from "./settlement";
import { MemoryStore, type StoredJob, type StoredNode } from "./store";
import { base58Encode } from "./wallet";

const g = globalThis as typeof globalThis & { __brainStore?: MemoryStore };
const store = () => g.__brainStore!;

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const address = base58Encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (m: string) => sign(null, Buffer.from(m, "utf8"), privateKey).toString("base64") };
}

function node(id: string, walletAddress?: string, extra: Partial<StoredNode> = {}): StoredNode {
  return {
    id,
    deviceClass: "OTHER_WEBGPU",
    status: "idle",
    computeScore: 10_000,
    advertisedMemoryGb: 1,
    joinedAt: 0,
    lastHeartbeatAt: 0,
    verifiedJobs: 0,
    failedJobs: 0,
    verifiedComputeUnits: 0,
    reputation: 0.95,
    provenance: "live",
    sessionHash: `s-${id}`,
    ipHash: "ip",
    walletAddress,
    walletVerified: Boolean(walletAddress),
    tokenAmount: 0,
    heartbeats: 0,
    clientReportedDevice: "",
    ...extra,
  };
}

let seq = 0;
function job(nodeId: string, at: number, units: number, verified = true): StoredJob {
  return {
    id: String(++seq),
    model: "tensor/matmul-u32",
    kind: "tensor",
    status: verified ? "completed" : "failed",
    nodeIds: [nodeId],
    workUnits: 1,
    computeUnits: units,
    submittedAt: at,
    lifecycle: [],
    provenance: "live",
    spec: { kernel: "matmul_u32", m: 8, n: 8, k: 8, seedA: 1, seedB: 2 },
    assignedTo: nodeId,
    issuedAt: at,
    deadline: at + 30_000,
    canary: false,
    sampleIndices: [],
    verified,
  };
}

const LIVE_ENV = { BRAIN_PAYOUTS_ENABLED: "true", SOLANA_RPC_URL: "http://rpc.invalid", BRAIN_PAYOUT_SECRET_KEY: "set-in-test" };
const saved: Record<string, string | undefined> = {};

function fakeSender(fail = false) {
  const sent: { to: string; lamports: number }[] = [];
  const s: PayoutSender & { sent: typeof sent } = {
    address: Keypair.generate().publicKey.toBase58(),
    sent,
    async send(to, lamports) {
      if (fail) throw new Error("rpc down");
      sent.push({ to, lamports });
      return `sig${sent.length}`;
    },
    async status() {
      return "confirmed";
    },
  };
  return s;
}

async function seedLive(address: string, lamports: number, provenance: "live" | "simulated" = "live") {
  const e = epochAt(Date.now() - 3 * epochLengthMs());
  const epoch: RewardEpoch = { ...e, poolLamports: lamports * 10, distributedLamports: lamports, participants: 1, totalVerifiedCompute: 1, settledAt: Date.now(), provenance };
  const a: RewardAllocation = {
    epochId: e.id,
    wallet: address,
    lamports,
    verifiedCompute: 1,
    jobsAssigned: 1,
    jobsCompleted: 1,
    availability: 1,
    multiplier: 1,
    quality: 1,
    computeShare: 1,
    capped: false,
    provenance,
  };
  await store().saveSettlement(epoch, [a]);
}

beforeEach(() => {
  g.__brainStore = new MemoryStore();
  for (const k of Object.keys(LIVE_ENV)) saved[k] = process.env[k];
  setPayoutSender(undefined);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setPayoutSender(undefined);
});

describe("payout transaction", () => {
  it("matches @solana/web3.js byte for byte", () => {
    const kp = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const blockhash = Keypair.generate().publicKey.toBase58();
    const { privateKey, address } = keyFromSecret(kp.secretKey);
    expect(address).toBe(kp.publicKey.toBase58());

    const ours = signedTransfer(privateKey, address, to.toBase58(), 123_456_789, blockhash);
    const ref = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports: 123_456_789 }),
    );
    ref.sign(kp);
    expect(ours.wire.equals(ref.serialize())).toBe(true);
    expect(ours.signature).toBe(base58Encode(ref.signature!));
  });

  it("refuses zero, fractional and self transfers", () => {
    const a = Keypair.generate().publicKey.toBase58();
    const b = Keypair.generate().publicKey.toBase58();
    const bh = Keypair.generate().publicKey.toBase58();
    expect(() => transferMessage(a, b, 0, bh)).toThrow();
    expect(() => transferMessage(a, b, 1.5, bh)).toThrow();
    expect(() => transferMessage(a, a, 10, bh)).toThrow();
  });
});

describe("settlement", () => {
  const len = () => epochLengthMs();
  const start = () => epochAt(Date.now() - 2 * len()).startsAt;

  it("expired or reassigned units lower the completion factor but do not disqualify; wrong results still do", async () => {
    const [w1, w2, w3] = [wallet(), wallet(), wallet()];
    const s = store();
    await s.saveNode(node("B001", w1.address));
    await s.saveNode(node("B002", w2.address));
    await s.saveNode(node("B003", w3.address));
    const t0 = start();
    for (let i = 0; i < 10; i++) {
      await s.saveJob(job("B001", t0 + i * 60_000, 10));
      await s.saveJob(job("B002", t0 + i * 60_000, 10));
      await s.saveJob(job("B003", t0 + i * 60_000, 10));
    }
    // B001: 10 verified + 10 units the server expired while it was slow (the incident pattern).
    for (let i = 0; i < 10; i++) await s.saveJob({ ...job("B001", t0 + 30_000 + i * 60_000, 10, false), failReason: "deadline" });
    // B002: 10 verified + 3 results that failed verification -> pass rate 77% < 90%.
    for (let i = 0; i < 3; i++) await s.saveJob({ ...job("B002", t0 + 30_000 + i * 60_000, 10, false), failReason: "sample mismatch" });

    const { wallets } = await measureWork(t0, t0 + len());
    const by = Object.fromEntries(wallets.map((w) => [w.wallet, w]));
    expect(by[w1.address].passed / by[w1.address].checked).toBe(1); // deadlines not counted as checks
    expect(by[w1.address].jobsCompleted / by[w1.address].jobsAssigned).toBe(0.5); // but completion reflects them
    expect(by[w2.address].passed / by[w2.address].checked).toBeLessThan(0.9);

    await settleEpoch({ epochStart: t0, poolLamports: 1_000_000_000 });
    const [a1, a2, a3] = await Promise.all([w1, w2, w3].map((w) => s.allocationsForWallet(w.address)));
    expect(a1).toHaveLength(1);
    expect(a1[0].lamports).toBeGreaterThan(0);
    expect(a3).toHaveLength(1);
    expect(a2).toHaveLength(0); // wrong results still disqualify
  });

  it("pays only verified compute from wallet-linked, non-banned nodes", async () => {
    const [w1, w2, w3] = [wallet(), wallet(), wallet()];
    const s = store();
    await s.saveNode(node("A001", w1.address));
    await s.saveNode(node("A002", w2.address));
    await s.saveNode(node("A003")); // no wallet
    await s.saveNode(node("A004", w3.address, { status: "banned" }));
    const t0 = start();
    for (let i = 0; i < 20; i++) {
      await s.saveJob(job("A001", t0 + i * 60_000, 10));
      await s.saveJob(job("A002", t0 + i * 60_000, 5));
      await s.saveJob(job("A003", t0 + i * 60_000, 50));
      await s.saveJob(job("A004", t0 + i * 60_000, 50));
    }
    await s.saveJob(job("A002", t0 + 1, 999, false)); // failed work earns nothing

    const { epoch, created } = await settleEpoch({ epochStart: t0, poolLamports: 1_000_000_000 });
    expect(created).toBe(true);
    const a1 = await s.allocationsForWallet(w1.address);
    const a2 = await s.allocationsForWallet(w2.address);
    expect(a1).toHaveLength(1);
    expect(a2).toHaveLength(1);
    expect(a1[0].verifiedCompute).toBe(200);
    expect(a2[0].verifiedCompute).toBe(100);
    // Two eligible wallets: the adaptive cap is 25% each (small-network ceiling); the rest stays undistributed.
    expect(a1[0].capped && a2[0].capped).toBe(true);
    expect(a1[0].lamports).toBe(250_000_000);
    expect(epoch.distributedLamports).toBe(500_000_000);
    expect(await s.allocationsForWallet(w3.address)).toHaveLength(0);
    expect(epoch.distributedLamports).toBeLessThanOrEqual(epoch.poolLamports);
    expect(Number.isInteger(a1[0].lamports)).toBe(true);
  });

  it("is idempotent and refuses open epochs", async () => {
    const t0 = start();
    const first = await settleEpoch({ epochStart: t0, poolLamports: 10 });
    const again = await settleEpoch({ epochStart: t0, poolLamports: 999 });
    expect(again.created).toBe(false);
    expect(again.epoch.poolLamports).toBe(first.epoch.poolLamports);
    await expect(settleEpoch({ epochStart: epochAt(Date.now()).startsAt })).rejects.toThrow("epoch_open");
  });

  it("is simulated unless the operator funds the pool and holdings are on-chain", async () => {
    const w = wallet();
    await store().saveNode(node("B001", w.address));
    await store().saveJob(job("B001", start() + 1000, 10));
    const sim = await settleEpoch({ epochStart: start() });
    expect(sim.epoch.provenance).toBe("simulated");
    const t1 = epochAt(Date.now() - 3 * len()).startsAt;
    await store().saveJob(job("B001", t1 + 1000, 10));
    // Operator pool, but holdings come from the demo source (no token mint configured).
    const stillSim = await settleEpoch({ epochStart: t1, poolLamports: 5_000_000_000 });
    expect(stillSim.epoch.provenance).toBe("simulated");
    expect((await balanceOf(w.address)).claimable).toBe(0);
  });
});

describe("claims", () => {
  function enable(sender: PayoutSender) {
    Object.assign(process.env, LIVE_ENV);
    setPayoutSender(sender);
  }

  it("is disabled without the kill switch", async () => {
    const w = wallet();
    await seedLive(w.address, 50_000_000);
    expect(payoutStatus().enabled).toBe(false);
    await expect(issueClaim(w.address)).rejects.toThrow("payouts_disabled");
  });

  it("pays the signer exactly their balance, once", async () => {
    const sender = fakeSender();
    enable(sender);
    const w = wallet();
    await seedLive(w.address, 50_000_000);
    const { message, lamports } = await issueClaim(w.address);
    expect(lamports).toBe(50_000_000);
    const c = await claim(w.address, message, w.sign(message));
    expect(c.status).toBe("sent");
    expect(sender.sent).toEqual([{ to: w.address, lamports: 50_000_000 }]);
    expect((await balanceOf(w.address)).claimable).toBe(0);
    // Replaying the same signed message fails on the nonce.
    await expect(claim(w.address, message, w.sign(message))).rejects.toThrow("claim_in_progress");
    await expect(issueClaim(w.address)).rejects.toThrow("nothing_to_claim");
    expect(sender.sent).toHaveLength(1);
  });

  it("rejects tampered amounts, wrong signers and simulated balances", async () => {
    enable(fakeSender());
    const w = wallet();
    const other = wallet();
    await seedLive(w.address, 50_000_000);
    const { message } = await issueClaim(w.address);
    const inflated = message.replace("Lamports: 50000000", "Lamports: 90000000");
    await expect(claim(w.address, inflated, w.sign(inflated))).rejects.toThrow("invalid_claim");
    await expect(claim(w.address, message, other.sign(message))).rejects.toThrow("bad_signature");
    await expect(claim(other.address, message, other.sign(message))).rejects.toThrow("invalid_claim");

    const sim = wallet();
    await seedLive(sim.address, 50_000_000, "simulated");
    await expect(issueClaim(sim.address)).rejects.toThrow("nothing_to_claim");
  });

  it("two claims signed against one balance pay once", async () => {
    const sender = fakeSender();
    enable(sender);
    const w = wallet();
    await seedLive(w.address, 50_000_000);
    const a = await issueClaim(w.address);
    const b = await issueClaim(w.address);
    await claim(w.address, a.message, w.sign(a.message));
    await expect(claim(w.address, b.message, w.sign(b.message))).rejects.toThrow("insufficient_balance");
    expect(sender.sent).toHaveLength(1);
  });

  it("a failed send restores the balance", async () => {
    enable(fakeSender(true));
    const w = wallet();
    await seedLive(w.address, 50_000_000);
    const { message } = await issueClaim(w.address);
    const c = await claim(w.address, message, w.sign(message));
    expect(c.status).toBe("failed");
    expect((await balanceOf(w.address)).claimable).toBe(50_000_000);
  });

  it("enforces the daily payout cap", async () => {
    enable(fakeSender());
    process.env.BRAIN_PAYOUT_DAILY_MAX_SOL = "0.03";
    const w = wallet();
    await seedLive(w.address, 50_000_000);
    const { message } = await issueClaim(w.address);
    await expect(claim(w.address, message, w.sign(message))).rejects.toThrow("daily_payout_cap");
    delete process.env.BRAIN_PAYOUT_DAILY_MAX_SOL;
  });
});

describe("summary", () => {
  it("shows labeled demo history only while payouts are off and nothing settled", async () => {
    const w = wallet();
    const s = await rewardsSummary(w.address);
    expect(s.demo).toBe(true);
    expect(s.epochs.length).toBeGreaterThan(0);
    expect(s.epochs.every((e) => e.provenance === "simulated")).toBe(true);
    expect(s.claimableLamports).toBe(0);

    enable(fakeSender());
    const live = await rewardsSummary(w.address);
    expect(live.demo).toBe(false);
    expect(live.epochs).toHaveLength(0);
  });

  function enable(sender: PayoutSender) {
    Object.assign(process.env, LIVE_ENV);
    setPayoutSender(sender);
  }
});

describe("wallet link token", () => {
  it("round-trips, expires, and rejects tampering", async () => {
    const { issueLinkToken, verifyLinkToken } = await import("./wallet");
    const w = wallet();
    const t = issueLinkToken(w.address);
    expect(verifyLinkToken(t)).toBe(w.address);
    const [a, exp, tag] = t.split(".");
    expect(verifyLinkToken(`${wallet().address}.${exp}.${tag}`)).toBeNull();
    expect(verifyLinkToken(`${a}.${Number(exp) + 1}.${tag}`)).toBeNull();
    expect(verifyLinkToken(`${a}.${Date.now() - 1}.${tag}`)).toBeNull();
    expect(verifyLinkToken("garbage")).toBeNull();
  });
});

describe("end to end: verified work → linked wallet → auto-settle from creator fees → claim", () => {
  it("pays from the treasury, paced per epoch, only to linked wallets, and never writes simulated epochs for real money", async () => {
    const { settleDueEpochs, treasuryPoolLamports } = await import("./settlement");
    const { getTreasury } = await import("./treasury");
    const { record } = await import("./accounting");
    Object.assign(process.env, LIVE_ENV);
    process.env.BRAIN_EPOCH_MINUTES = "60";
    process.env.BRAIN_POOL_PACE_DAYS = "1";
    process.env.BRAIN_TOKEN_MINT = "FiJ4gnd4dhqNeBKfS4E8wnERMEpjMPdUfJhu8foipump";
    delete process.env.BRAIN_EPOCH_POOL_SOL;
    const sender = fakeSender();
    setPayoutSender(sender);
    const s = store();

    // 29.78 SOL of creator fees recorded in the REAL ledger (as the on-chain adapter would).
    const t = await getTreasury("REAL");
    t.received = t.balance = 29.78;
    t.references.push("4DLu9xqbYcSIG");
    await s.putDoc("treasury", "REAL", t, { at: Date.now(), key: "REAL" });
    await record({ type: "CREATOR_REWARD_RECEIVED", amount: 29.78, currency: "SOL", timestamp: Date.now(), source: "REAL", settlement: "settled", transactionReference: "4DLu9xqbYcSIG" });

    // Hourly pacing over one day: each epoch gets 1/24 of the 50% contributor share.
    const hour = 60 * 60_000;
    const pool = await treasuryPoolLamports(hour);
    expect(pool).toBe(Math.floor((29.78 * 0.5) / 24 * 1e9));

    // Work in the last closed hour. Node A linked a wallet, node B did not.
    const w = wallet();
    await s.saveNode(node("A001", w.address));
    await s.saveNode(node("A002"));
    const last = epochAt(Date.now() - hour);
    for (let i = 0; i < 12; i++) {
      await s.saveJob(job("A001", last.startsAt + i * 5 * 60_000 + 1, 100));
      await s.saveJob(job("A002", last.startsAt + i * 5 * 60_000 + 1, 100));
    }

    // Holdings come from chain in LIVE_ENV; stub the RPC so holdings resolve as live with zero tokens.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const { method } = JSON.parse(String(init?.body)) as { method: string };
      const result = method === "getTokenAccountsByOwner" ? { value: [] } : method === "getTokenSupply" ? { value: { amount: "1000000000000000", decimals: 6, uiAmount: 1e9 } } : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const settled = await settleDueEpochs(Date.now());
      expect(settled).toHaveLength(1);
      const e = settled[0];
      expect(e.provenance).toBe("live");
      expect(e.poolLamports).toBe(pool);
      expect(e.participants).toBe(1);
      // One participant hits the small-network cap (25%); the rest of the pool stays in the treasury.
      expect(e.distributedLamports).toBe(Math.floor(pool * 0.25));
      const after = await getTreasury("REAL");
      expect(after.allocated).toBeCloseTo(e.distributedLamports / 1e9, 9);
      expect(after.balance).toBeCloseTo(29.78 - e.distributedLamports / 1e9, 9);
      // Idempotent and throttled.
      expect(await settleDueEpochs(Date.now())).toHaveLength(0);

      // Operator report agrees with what was paid: A001 linked and paid, A002 worked but unlinked.
      const { epochWorkReport } = await import("./settlement");
      const report = await epochWorkReport(last.startsAt);
      expect(report.state).toBe("settled");
      expect(report.wallets).toEqual([expect.objectContaining({ wallet: w.address, nodes: ["A001"], lamports: e.distributedLamports, capped: true })]);
      expect(report.unlinked).toEqual({ nodes: 1, verifiedCompute: 1200 });
      expect(report.nodes.map((n) => [n.nodeId, n.walletVerified])).toEqual(expect.arrayContaining([["A001", true], ["A002", false]]));

      // Claim: linked wallet gets exactly its allocation; the unlinked node gets nothing.
      const bal = await balanceOf(w.address);
      expect(bal.claimable).toBe(e.distributedLamports);
      const { message } = await issueClaim(w.address);
      const c = await claim(w.address, message, w.sign(message));
      expect(c.status).toBe("sent");
      expect(sender.sent).toEqual([{ to: w.address, lamports: e.distributedLamports }]);

      // RPC down while settling real money: holdings read as zero (multiplier 1) and the epoch still
      // settles LIVE and claimable. It is never written as simulated.
      globalThis.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;
      const prev = epochAt(Date.now() - 2 * hour);
      await s.saveJob(job("A001", prev.startsAt + 1, 100));
      const r = await settleEpoch({ epochStart: prev.startsAt });
      expect(r.created).toBe(true);
      expect(r.epoch.provenance).toBe("live");
      expect((await s.allocationsForWallet(w.address)).every((a) => a.multiplier === 1)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.BRAIN_EPOCH_MINUTES;
      delete process.env.BRAIN_POOL_PACE_DAYS;
      delete process.env.BRAIN_TOKEN_MINT;
    }
  });
});
