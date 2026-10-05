/**
 * Consumer plans. Paid plans are announced with their intended price and shown as COMING SOON
 * until billing is connected; nothing here charges anyone and no paid plan can be selected.
 *
 * BRAIN Credits are a unit of real cost, not a token: 1 credit = BRAIN_CREDIT_USD (default $0.001).
 * A request consumes `customerCost / BRAIN_CREDIT_USD` credits; when the cost is UNKNOWN the
 * consumption is recorded as UNKNOWN and nothing is deducted (see services/credits.ts).
 */
export type PlanId = "FREE" | "PRO" | "CODE" | "MAX";

export interface Plan {
  id: PlanId;
  name: string;
  /** USD per month. null = not priced. */
  priceUsd: number | null;
  /** True for paid plans until a payment processor is connected: shown as COMING SOON, not selectable. */
  placeholder: boolean;
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
      tagline: "Try BRAIN.",
      blurb: "Routed for cost. Every answer comes with its receipt.",
      highlights: ["AUTO and CHEAP routing", "500 credits a month", "Receipts on every answer", "Earn credits, USDC or SOL with your GPU"],
    },
    {
      id: "PRO",
      name: "Pro",
      priceUsd: num(env.BRAIN_PLAN_PRO_USD, 20),
      placeholder: true,
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

/** Whether real payments can be taken. False until a processor is wired; the UI reads this. */
export const paymentsConnected = () => false;
