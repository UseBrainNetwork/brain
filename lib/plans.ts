/**
 * Consumer plans. Prices are PLACEHOLDERS until billing is connected; every surface that shows
 * them must say so. Nothing here charges anyone: there is no payment processor in this codebase.
 *
 * BRAIN Credits are a unit of real cost, not a token: 1 credit = BRAIN_CREDIT_USD (default $0.001).
 * A request consumes `customerCost / BRAIN_CREDIT_USD` credits; when the cost is UNKNOWN the
 * consumption is recorded as UNKNOWN and nothing is deducted (see services/credits.ts).
 */
export type PlanId = "FREE" | "PRO" | "MAX";

export interface Plan {
  id: PlanId;
  name: string;
  /** USD per month. null = not priced. */
  priceUsd: number | null;
  /** True until a payment processor sets real prices. */
  placeholder: boolean;
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
      includedCredits: num(env.BRAIN_PLAN_FREE_CREDITS, 500),
      rateLimit: 10,
      modes: ["AUTO", "CHEAP", "BROWSER_ONLY"],
      privateRouting: false,
      blurb: "Try BRAIN. Routed for cost. Every answer comes with its receipt.",
    },
    {
      id: "PRO",
      name: "Pro",
      priceUsd: num(env.BRAIN_PLAN_PRO_USD, 10),
      placeholder: true,
      includedCredits: num(env.BRAIN_PLAN_PRO_CREDITS, 12_000),
      rateLimit: 60,
      modes: ["AUTO", "CHEAP", "FAST", "QUALITY", "BROWSER_ONLY"],
      privateRouting: false,
      blurb: "All routing modes. Higher limits. Compute you contribute offsets what you use.",
    },
    {
      id: "MAX",
      name: "Max",
      priceUsd: num(env.BRAIN_PLAN_MAX_USD, 25),
      placeholder: true,
      includedCredits: num(env.BRAIN_PLAN_MAX_CREDITS, 35_000),
      rateLimit: 120,
      modes: ["AUTO", "CHEAP", "FAST", "QUALITY", "BROWSER_ONLY"],
      privateRouting: true,
      blurb: "Private routing on operator infrastructure. Priority capacity as the network grows.",
    },
  ];
}

/** Plans a visitor can actually choose today. Placeholder plans stay in config but off every public surface until billing exists. */
export const visiblePlans = () => plans().filter((p) => !p.placeholder || paymentsConnected());

export const planById = (id: PlanId) => plans().find((p) => p.id === id) ?? plans()[0];

/** Whether real payments can be taken. False until a processor is wired; the UI reads this. */
export const paymentsConnected = () => false;
