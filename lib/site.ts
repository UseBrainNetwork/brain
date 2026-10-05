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

/**
 * Protocol wallet. Creator fees from the token are claimed to this address and it funds the
 * contributor pool. Public, read-only; the server never holds its key. Balance and inbound
 * transfers are read from chain and shown LIVE; nothing enters the reward ledger until an
 * operator confirms a transaction signature (see services/treasury.ts).
 */
export const protocolWallet = {
  address: "HZLev74M3ATV5jQJsoN8FcJAKx3RUefAobhcXr3egxwa",
  cluster: (process.env.BRAIN_SOLANA_CLUSTER ?? process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? "mainnet-beta") as "mainnet-beta" | "devnet" | "testnet",
} as const;

export const accountUrl = (address: string, cluster: string = protocolWallet.cluster) => `https://solscan.io/account/${address}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;
export const txUrl = (sig: string, cluster: string = protocolWallet.cluster) => `https://solscan.io/tx/${sig}${cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`}`;

export const social = {
  xHandle: "useBrainnetwork",
  xUrl: "https://x.com/useBrainnetwork",
  githubOrg: "UseBrainNetwork",
  githubUrl: "https://github.com/UseBrainNetwork",
  repoUrl: "https://github.com/UseBrainNetwork/brain",
} as const;
