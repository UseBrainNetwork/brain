/**
 * Consumer plans. Paid plans are bought on-chain: the price in USD is paid in USDC, or in SOL at a
 * real quoted rate, to the protocol wallet (services/payments.ts). A plan can also be unlocked by
 * holding the BRAIN token above a per-plan threshold while the holding lasts (services/subscriptions.ts).
 * There is no fiat processor and no card; payments are Solana transactions anyone can read.
 *
 * BRAIN Credits are a unit of real cost, not a token: 1 credit = BRAIN_CREDIT_USD (default $0.001).
 * A request consumes `customerCost / BRAIN_CREDIT_USD` credits; when the cost is UNKNOWN the
 * consumption is recorded as UNKNOWN and nothing is deducted (see services/credits.ts).
 */
export type PlanId = "FREE" | "PRO" | "CODE" | "MAX";

/** A paid plan period: 30 days from purchase, extended by 30 days per further payment. */
export const PLAN_PERIOD_MS = 30 * 24 * 3600_000;

export interface Plan {
  id: PlanId;
  name: string;
  /** USD per month. null = not priced. */
  priceUsd: number | null;
  /** True for plans that cost money. Selectable whenever payments are on. */
  placeholder: boolean;
  /**
   * BRAIN tokens a linked wallet must hold for this plan to be unlocked without paying, re-checked
   * against the chain while it is active. null = the operator has not offered holder access for it.
   */
  holdTokens: number | null;
  /** One-line positioning under the name. */
  tagline: string;
  /** What the plan is for; shown as bullets. Describe capability classes, never a model we do not route to. */
  highlights: string[];
  /** Credits granted per calendar month. */
  includedCredits: number;
  /** Requests per minute. */
  rateLimit: number;
  /** Which routing modes the plan may request. */
  modes: ("AUTO" | "CHEAP" | "FAST" | "QUALITY" | "BROWSER_ONLY")[];
  /** Whether PRIVATE routing (operator infrastructure only) is available. */
  privateRouting: boolean;
  blurb: string;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : d;
};

/** Holder threshold: a positive token amount, or null when not offered. */
const hold = (v: string | undefined) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

export function creditUsd(): number {
  return num(process.env.BRAIN_CREDIT_USD, 0.001);
}

export function plans(): Plan[] {
  const env = process.env;
  return [
    {
      id: "FREE",
      name: "Free",
      priceUsd: 0,
      placeholder: false,
      holdTokens: null,
      includedCredits: num(env.BRAIN_PLAN_FREE_CREDITS, 500),
      rateLimit: 10,
      modes: ["AUTO", "CHEAP", "BROWSER_ONLY"],
      privateRouting: false,
      tagline: "Try BRAIN.",
      blurb: "Routed for cost. Every answer comes with its receipt.",
      highlights: ["AUTO and CHEAP routing", "500 credits a month", "Receipts on every answer", "Earn credits, USDC or SOL with your GPU"],
    },
    {
      id: "PRO",
      name: "Pro",
      priceUsd: num(env.BRAIN_PLAN_PRO_USD, 20),
      placeholder: true,
      holdTokens: hold(env.BRAIN_PLAN_PRO_HOLD_TOKENS),
      includedCredits: num(env.BRAIN_PLAN_PRO_CREDITS, 20_000),
      rateLimit: 60,
      modes: ["AUTO", "CHEAP", "FAST", "QUALITY", "BROWSER_ONLY"],
      privateRouting: false,
      tagline: "Every route, higher limits.",
      blurb: "All four routing modes, including FAST and QUALITY, and 40× the credits.",
      highlights: ["FAST and QUALITY routing", "20,000 credits a month", "60 requests a minute", "API keys with Pro limits"],
    },
    {
      id: "CODE",
      name: "Code",
      priceUsd: num(env.BRAIN_PLAN_CODE_USD, 40),
      placeholder: true,
      holdTokens: hold(env.BRAIN_PLAN_CODE_HOLD_TOKENS),
      includedCredits: num(env.BRAIN_PLAN_CODE_CREDITS, 45_000),
      rateLimit: 120,
      modes: ["AUTO", "CHEAP", "FAST", "QUALITY", "BROWSER_ONLY"],
      privateRouting: false,
      tagline: "Built for shipping software.",
      blurb: "Routes to the strongest coding models BRAIN can reach, with long context and a routing profile tuned for code.",
      highlights: ["Frontier coding models, QUALITY by default", "Long-context requests", "45,000 credits a month", "OpenAI-compatible API for editors and agents"],
    },
    {
      id: "MAX",
      name: "Max",
      priceUsd: num(env.BRAIN_PLAN_MAX_USD, 100),
      placeholder: true,
      holdTokens: hold(env.BRAIN_PLAN_MAX_HOLD_TOKENS),
      includedCredits: num(env.BRAIN_PLAN_MAX_CREDITS, 120_000),
      rateLimit: 300,
      modes: ["AUTO", "CHEAP", "FAST", "QUALITY", "BROWSER_ONLY"],
      privateRouting: true,
      tagline: "Everything BRAIN can reach.",
      blurb: "The largest reasoning and multimodal models on the network, private routing, and priority capacity.",
      highlights: ["Largest reasoning and multimodal models", "PRIVATE routing on operator infrastructure", "120,000 credits a month", "Priority capacity, 300 requests a minute"],
    },
  ];
}

/** Plans a visitor can actually choose today. */
export const selectablePlans = () => plans().filter((p) => !p.placeholder || paymentsConnected());

/** Whether a plan is announced but not yet purchasable. */
export const comingSoon = (p: Plan) => p.placeholder && !paymentsConnected();

export const planById = (id: PlanId) => plans().find((p) => p.id === id) ?? plans()[0];

/**
 * Whether paid plans can be bought. On by default: the rail is a Solana transfer to the protocol
 * wallet verified on-chain, which needs nothing but an RPC. `BRAIN_PAYMENTS=off` closes it.
 */
export const paymentsConnected = () => process.env.BRAIN_PAYMENTS !== "off";

/** Plans that a wallet holding `amount` BRAIN tokens unlocks, best first. Empty when none are offered. */
export function plansUnlockedByHolding(amount: number): Plan[] {
  return plans()
    .filter((p) => p.holdTokens != null && amount >= p.holdTokens)
    .sort((a, b) => (b.priceUsd ?? 0) - (a.priceUsd ?? 0));
}

/** Plans that offer holder access at all, cheapest first. */
export const holderPlans = () => plans().filter((p) => p.holdTokens != null).sort((a, b) => (a.holdTokens ?? 0) - (b.holdTokens ?? 0));

/** Rank for upgrade/downgrade comparisons. */
export const planRank = (id: PlanId) => ["FREE", "PRO", "CODE", "MAX"].indexOf(id);
