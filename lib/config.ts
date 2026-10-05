/**
 * Network / anti-cheat configuration. Server-side values; safe to import on the client
 * (contains no secrets) so UI copy can reference the same numbers.
 */
export const networkConfig = {
  /** Benchmark score = trusted mix-rounds/sec ÷ this. Calibrated so a high-end laptop GPU lands ~10–30k. */
  scoreScale: 1e7,
  benchmark: {
    threads: 1 << 20,
    blockSize: 1024,
    /** Target GPU time for the challenge; large enough that network RTT is noise. */
    targetMs: 400,
    minRounds: 64,
    maxRounds: 16384,
    /** Blocks the server recomputes. Hidden from the client until it has answered. */
    sampledBlocks: 3,
    challengeTtlMs: 30_000,
  },
  jobs: {
    canaryRate: 0.2,
    sampledRows: 6,
    deadlineMs: 30_000,
    /** Results returned faster than this many ops/ms are physically implausible for a browser. */
    maxPlausibleOpsPerMs: 5e9,
  },
  nodes: {
    heartbeatMs: 10_000,
    /** A node silent this long is LOST: its pending work units are reassigned. */
    offlineAfterMs: 30_000,
  },
  distributed: {
    /** Work-unit dims per size. Integer matmul, rows hashed per output row. Calibrated for 3–6 s jobs. */
    sizes: {
      small: { m: 512, n: 512, k: 512 },
      medium: { m: 1024, n: 1024, k: 512 },
      large: { m: 1024, n: 1024, k: 1024 },
    },
    defaultUnitsPerNode: 4,
    maxUnits: 64,
    /** Rows the server recomputes per unit. Catching a 25% skip: 1-(0.75)^rows. */
    sampledRows: 8,
    unitDeadlineMs: 20_000,
    maxAttemptsPerUnit: 3,
    /** Only one distributed job in flight per server; a second POST gets 409. */
    jobTtlMs: 120_000,
  },
  reputation: {
    initial: 0.75,
    alpha: 0.12,
    banBelow: 0.35,
    minJobsBeforeBan: 4,
  },
  rewards: {
    /** Default epoch length. Override server-side with BRAIN_EPOCH_MINUTES. */
    epochMs: 24 * 60 * 60_000,
    /** Availability = share of these buckets in which the wallet held an assigned job. */
    availabilityBucketMs: 5 * 60_000,
    /** Claims below this are refused: network fees would eat them. */
    minClaimLamports: 10_000_000,
    claimTtlMs: 5 * 60_000,
  },
  rateLimit: {
    /** Requests per window per IP for node endpoints. */
    nodeRequests: 600,
    windowMs: 60_000,
    /** Requests per window per IP for inference. */
    inferenceRequests: 20,
  },
} as const;
