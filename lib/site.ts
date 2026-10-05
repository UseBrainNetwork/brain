export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

/** Public, non-secret identities. */
export const social = {
  xHandle: "useBrainnetwork",
  xUrl: "https://x.com/useBrainnetwork",
  githubOrg: "UseBrainNetwork",
  githubUrl: "https://github.com/UseBrainNetwork",
  repoUrl: "https://github.com/UseBrainNetwork/brain",
} as const;
