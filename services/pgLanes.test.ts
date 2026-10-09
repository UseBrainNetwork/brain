import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PgStore lane failover, with `pg` mocked: each Pool records the connection string it was built
 * with and answers queries from a per-URL script. No database involved.
 */
const scripts = new Map<string, (text: string) => unknown>();
const poolUrls: string[] = [];

vi.mock("pg", () => {
  class Pool {
    private url: string;
    constructor(cfg: { connectionString: string }) {
      this.url = cfg.connectionString;
      poolUrls.push(this.url);
    }
    on() {
      return this;
    }
    async query(text: string) {
      const run = scripts.get(this.url);
      if (!run) throw new Error(`no script for ${this.url}`);
      const r = run(text);
      if (r instanceof Error) throw r;
      return r;
    }
    async connect() {
      await this.query("connect");
      return { query: async () => ({ rows: [] }), release() {} };
    }
  }
  return { Pool };
});

const poisoned = () => Object.assign(new Error("Authentication credentials are invalid. Please reconnect with fresh credentials to restore pool functionality."), { code: "28P01" });
const saturated = () => new Error("(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15");
const marker = (text: string) => ({ rows: text.includes("'schema'") ? [{ v: "x" }] : [{ ok: 1 }], rowCount: 1 });

const PRIMARY = "postgres://a:pw@db.pooler.supabase.com:6543/postgres";
const ALT = "postgres://b:pw@db.pooler.supabase.com:6543/postgres";
const SESSION = "postgres://a:pw@db.pooler.supabase.com:5432/postgres";

describe("PgStore lanes", () => {
  beforeEach(() => {
    scripts.clear();
    poolUrls.length = 0;
    process.env.BRAIN_SKIP_MIGRATE = "true";
  });

  it("BRAIN_PG_LANE_ORDER puts the named lanes first and leaves the rest in default order", async () => {
    process.env.BRAIN_PG_LANE_ORDER = "alternate";
    try {
      const { PgStore } = await import("./pgStore");
      const s = new PgStore(PRIMARY, ALT);
      expect(s.laneStatus().map((l) => l.name)).toEqual(["alternate", "primary", "session"]);
      scripts.set(ALT, marker);
      scripts.set(PRIMARY, () => poisoned());
      scripts.set(SESSION, marker);
      await s.getNodes([]);
      expect(s.laneStatus().every((l) => l.coolingDownSec === 0)).toBe(true); // primary never touched
    } finally {
      delete process.env.BRAIN_PG_LANE_ORDER;
    }
  });

  it("builds primary, alternate and session lanes from a Supabase pooler URL", async () => {
    const { PgStore } = await import("./pgStore");
    const s = new PgStore(PRIMARY, ALT);
    expect(new Set(poolUrls)).toEqual(new Set([PRIMARY, ALT, SESSION]));
    expect(s.laneStatus().map((l) => [l.name, l.mode])).toEqual([
      ["primary", "transaction"],
      ["alternate", "transaction"],
      ["session", "session"],
    ]);
  });

  it("fails over to the alternate role when the primary pool is poisoned, and stays there", async () => {
    const { PgStore } = await import("./pgStore");
    let primaryCalls = 0;
    let altCalls = 0;
    scripts.set(PRIMARY, () => (primaryCalls++, poisoned()));
    scripts.set(ALT, (t) => (altCalls++, marker(t)));
    scripts.set(SESSION, () => new Error("session must not be used while the alternate works"));
    const s = new PgStore(PRIMARY, ALT);
    expect(await s.getEpoch("e1")).toBeNull();
    expect(await s.getEpoch("e2")).toBeNull();
    // Two attempts on the primary (one retry), then none: it is cooling down.
    expect(primaryCalls).toBe(2);
    expect(altCalls).toBe(2);
    expect(s.poolerMode()).toBe("transaction");
    const st = s.laneStatus();
    expect(st[0].coolingDownSec).toBeGreaterThan(0);
    expect(st[1].coolingDownSec).toBe(0);
  });

  it("falls through to the session pooler when both roles are rejected, and reports a 503-class error when all are", async () => {
    const { PgStore } = await import("./pgStore");
    scripts.set(PRIMARY, () => poisoned());
    scripts.set(ALT, () => poisoned());
    scripts.set(SESSION, (t) => marker(t));
    const s = new PgStore(PRIMARY, ALT);
    expect(await s.getEpoch("e1")).toBeNull();
    expect(s.poolerMode()).toBe("session");
    scripts.set(SESSION, () => saturated());
    const s2 = new PgStore(PRIMARY, ALT);
    await expect(s2.getEpoch("e1")).rejects.toThrow(/max clients reached/);
    expect(s2.laneStatus().every((l) => l.coolingDownSec > 0)).toBe(true);
  });

  it("does not fail over on ordinary statement errors", async () => {
    const { PgStore } = await import("./pgStore");
    let altCalls = 0;
    scripts.set(PRIMARY, () => Object.assign(new Error("relation does not exist"), { code: "42P01" }));
    scripts.set(ALT, (t) => (altCalls++, marker(t)));
    const s = new PgStore(PRIMARY, ALT);
    await expect(s.getEpoch("e1")).rejects.toThrow(/relation/);
    expect(altCalls).toBe(0);
    expect(s.laneStatus()[0].coolingDownSec).toBe(0);
  });
});
