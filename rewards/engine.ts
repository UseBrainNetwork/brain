/**
 * Reward engine (v2). Pure, configurable, exhaustively tested in engine.test.ts.
 *
 *   normalizedOwnership_i = min(tokenOwnership_i / supply, holdingCap) / holdingCap        ∈ [0, 1]
 *   holdingMultiplier_i   = min(1 + alpha · ln(1 + normalizedOwnership_i), maxHoldingMultiplier)
 *   qualityMultiplier_i   = reputation_i · reliability_i                                   ∈ [0, 1]
 *   weight_i              = verifiedCompute_i · holdingMultiplier_i · qualityMultiplier_i · demand
 *   share_i               = weight_i / Σ weight, water-filled under maxNodeShare
 *   reward_i              = share_i · rewardPool
 *
 * Guarantees (tested):
 *   - verifiedCompute = 0  ⇒  reward = 0, whatever the holdings.      "Holding is not yield."
 *   - holdingMultiplier is bounded, so reward ≤ maxHoldingMultiplier · (compute-only reward).
 *   - Splitting one account's compute across N sybil nodes never earns more than keeping it in
 *     one node: ln is concave (shards see smaller normalized holdings) and the cap is per account.
 *   - Below minReputation / minReliability a node earns nothing for the epoch.
 */

export interface RewardEngineConfig {
  /** Strength of the holding bonus. 0 disables holdings entirely. */
  alpha: number;
  /** Ownership share of supply above which holding adds nothing. */
  holdingCap: number;
  /** Absolute ceiling on holdingMultiplier. */
  maxHoldingMultiplier: number;
  /** Eligibility floors. */
  minReputation: number;
  minReliability: number;
  /**
   * No single ACCOUNT (wallet) may take more than this share of the pool. Rows sharing an
   * `accountId` are capped together, so splitting one wallet's compute across many nodes cannot
   * raise its total. Rows without an accountId are grouped by nodeId. Enforced once the epoch has
   * at least 1/maxAccountShare eligible accounts; with fewer the cap is unsatisfiable without
   * burning the pool, so it is lifted and `capLifted` is set.
   *
   * A per-node cap was rejected: it is sybil-exploitable (shards absorb a capped rival's excess).
   */
  maxAccountShare: number;
  circulatingSupply: number;
}

export const defaultEngineConfig: RewardEngineConfig = {
  alpha: 0.5,
  holdingCap: 0.01,
  maxHoldingMultiplier: 1.35,
  minReputation: 0.35,
  minReliability: 0.5,
  maxAccountShare: 0.25,
  circulatingSupply: 1_000_000_000,
};

export interface EngineInput {
  nodeId: string;
  /** Wallet / customer identity that owns this node. Caps are enforced per account. */
  accountId?: string;
  /** Server-verified compute units in the epoch. The only thing that can make reward > 0. */
  verifiedCompute: number;
  /** Tokens held (chain-verified or 0). */
  tokenOwnership: number;
  /** 0..1 */
  reputation: number;
  /** 0..1 */
  reliability: number;
}

export interface EngineRow {
  nodeId: string;
  accountId: string;
  eligible: boolean;
  reason?: "zero-compute" | "low-reputation" | "low-reliability";
  normalizedOwnership: number;
  holdingMultiplier: number;
  qualityMultiplier: number;
  weight: number;
  share: number;
  reward: number;
  capped: boolean;
}

export interface EngineResult {
  rewardPool: number;
  distributed: number;
  undistributed: number;
  /** Multiplies every weight equally; informational (relative shares are unaffected). */
  jobDemand: number;
  /** True when too few eligible nodes existed for maxNodeShare to be enforceable. */
  capLifted: boolean;
  rows: EngineRow[];
}

export function holdingMultiplier(tokenOwnership: number, cfg: RewardEngineConfig = defaultEngineConfig): number {
  if (!(tokenOwnership > 0) || cfg.alpha <= 0) return 1;
  const share = Math.min(tokenOwnership / cfg.circulatingSupply, cfg.holdingCap);
  const normalized = cfg.holdingCap > 0 ? share / cfg.holdingCap : 0;
  return Math.min(1 + cfg.alpha * Math.log(1 + normalized), cfg.maxHoldingMultiplier);
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export function allocate(inputs: EngineInput[], rewardPool: number, jobDemand = 1, cfg: RewardEngineConfig = defaultEngineConfig): EngineResult {
  const rows: EngineRow[] = inputs.map((c) => {
    const compute = Number.isFinite(c.verifiedCompute) && c.verifiedCompute > 0 ? c.verifiedCompute : 0;
    const reason: EngineRow["reason"] | undefined = compute <= 0 ? "zero-compute" : c.reputation < cfg.minReputation ? "low-reputation" : c.reliability < cfg.minReliability ? "low-reliability" : undefined;
    const share = Math.min(Math.max(0, c.tokenOwnership) / cfg.circulatingSupply, cfg.holdingCap);
    const normalizedOwnership = cfg.holdingCap > 0 ? share / cfg.holdingCap : 0;
    const hm = reason ? 0 : holdingMultiplier(c.tokenOwnership, cfg);
    const qm = reason ? 0 : clamp01(c.reputation) * clamp01(c.reliability);
    const weight = reason ? 0 : compute * hm * qm * Math.max(0, jobDemand);
    return { nodeId: c.nodeId, accountId: c.accountId ?? c.nodeId, eligible: !reason, reason, normalizedOwnership, holdingMultiplier: hm, qualityMultiplier: qm, weight, share: 0, reward: 0, capped: false };
  });
  const total = rows.reduce((s, r) => s + r.weight, 0);
  if (total > 0) for (const r of rows) r.share = r.weight / total;
  const accounts = new Set(rows.filter((r) => r.eligible).map((r) => r.accountId)).size;
  const capLifted = accounts * cfg.maxAccountShare < 1;
  if (!capLifted) waterFillAccounts(rows, cfg.maxAccountShare);
  const pool = Math.max(0, rewardPool);
  for (const r of rows) r.reward = r.share * pool;
  const distributed = rows.reduce((s, r) => s + r.reward, 0);
  return { rewardPool: pool, distributed, undistributed: Math.max(0, pool - distributed), jobDemand, capLifted, rows };
}

/** Cap each account's summed share at `cap`; redistribute excess to uncapped accounts pro rata. */
function waterFillAccounts(rows: EngineRow[], cap: number) {
  const byAccount = new Map<string, EngineRow[]>();
  for (const r of rows) {
    if (!r.eligible) continue;
    const g = byAccount.get(r.accountId);
    if (g) g.push(r);
    else byAccount.set(r.accountId, [r]);
  }
  const capped = new Set<string>();
  for (let i = 0; i < 64; i++) {
    let excess = 0;
    for (const [acct, g] of byAccount) {
      const sum = g.reduce((s, r) => s + r.share, 0);
      if (sum > cap + 1e-12) {
        const k = cap / sum;
        for (const r of g) {
          r.share *= k;
          r.capped = true;
        }
        excess += sum - cap;
        capped.add(acct);
      }
    }
    if (excess <= 1e-12) return;
    const open = [...byAccount].filter(([a]) => !capped.has(a)).flatMap(([, g]) => g);
    const openTotal = open.reduce((s, r) => s + r.share, 0);
    if (openTotal <= 0) return;
    for (const r of open) r.share += excess * (r.share / openTotal);
  }
}
