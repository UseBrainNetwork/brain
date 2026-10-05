export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

/** Public, non-secret identities. */
/** The one way we describe what contributors get. Credits are usable today; USDC and SOL settle to the contributor's Solana wallet when payouts are enabled. */
export const earn = {
  line: "Earn credits, USDC or SOL.",
  short: "credits · USDC · SOL",
  how: "Credits apply to your usage today. USDC and SOL settle to your Solana wallet when payouts open. Only verified work earns.",
} as const;

export const social = {
  xHandle: "useBrainnetwork",
  xUrl: "https://x.com/useBrainnetwork",
  githubOrg: "UseBrainNetwork",
  githubUrl: "https://github.com/UseBrainNetwork",
  repoUrl: "https://github.com/UseBrainNetwork/brain",
} as const;
