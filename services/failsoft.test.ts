import { beforeEach, describe, expect, it } from "vitest";
import { Breaker, isConnectivityError, lastKnownGood, resetLastKnownGood, StoreUnavailableError } from "./failsoft";

const connectTimeout = () => Object.assign(new Error("timeout exceeded when trying to connect"), {});
const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const sqlError = () => Object.assign(new Error('relation "x" does not exist'), { code: "42P01" });

describe("isConnectivityError", () => {
  it("recognises connection-level failures and not SQL errors", () => {
    expect(isConnectivityError(connectTimeout())).toBe(true);
    expect(isConnectivityError(refused())).toBe(true);
    expect(isConnectivityError(Object.assign(new Error("x"), { code: "57P03" }))).toBe(true);
    expect(isConnectivityError(Object.assign(new Error("x"), { code: "53300" }))).toBe(true);
    expect(isConnectivityError(sqlError())).toBe(false);
    expect(isConnectivityError(new Error("boom"))).toBe(false);
    expect(isConnectivityError(null)).toBe(false);
  });
});

describe("Breaker", () => {
  it("opens after the threshold, fails fast while open, probes once per window, closes on success", async () => {
    let t = 1_000_000;
    const b = new Breaker({ threshold: 2, openMs: 15_000, now: () => t });
    let calls = 0;
    const failing = () => (calls++, Promise.reject(connectTimeout()));

    await expect(b.run(failing)).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(b.open).toBe(false); // one failure: not yet
    await expect(b.run(failing)).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(b.open).toBe(true);
    expect(calls).toBe(2);

    // Open: the underlying operation is not even attempted.
    await expect(b.run(failing)).rejects.toMatchObject({ status: 503, retryAfterSec: 15 });
    await expect(b.run(failing)).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(calls).toBe(2);

    // Half-open after the window: exactly one probe goes through, a failure keeps it open.
    t += 15_000;
    await expect(b.run(failing)).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(calls).toBe(3);
    await expect(b.run(failing)).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(calls).toBe(3);

    // Next window: probe succeeds, breaker closes, traffic flows.
    t += 15_000;
    await expect(b.run(() => Promise.resolve("ok"))).resolves.toBe("ok");
    expect(b.open).toBe(false);
    await expect(b.run(() => Promise.resolve("ok2"))).resolves.toBe("ok2");
  });

  it("does not count SQL errors as connectivity failures", async () => {
    const b = new Breaker({ threshold: 1 });
    await expect(b.run(() => Promise.reject(sqlError()))).rejects.toMatchObject({ code: "42P01" });
    await expect(b.run(() => Promise.reject(sqlError()))).rejects.toMatchObject({ code: "42P01" });
    expect(b.open).toBe(false);
  });

  it("lets concurrent callers through only until the breaker opens", async () => {
    const b = new Breaker({ threshold: 2, openMs: 15_000 });
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => b.run(() => Promise.reject(refused()))));
    expect(results.every((r) => r.status === "rejected" && r.reason instanceof StoreUnavailableError)).toBe(true);
    expect(b.open).toBe(true);
  });
});

describe("lastKnownGood", () => {
  beforeEach(() => resetLastKnownGood());

  it("serves fresh within ttl, rebuilds after, returns previous body flagged stale on connectivity failure", async () => {
    let n = 0;
    let fail = false;
    const build = async () => {
      if (fail) throw connectTimeout();
      return { n: ++n };
    };
    const a = await lastKnownGood("k", 50, build);
    expect(a).toMatchObject({ body: { n: 1 }, stale: false });
    const b = await lastKnownGood("k", 50, build);
    expect(b.body).toEqual({ n: 1 }); // cached
    await new Promise((r) => setTimeout(r, 60));
    fail = true;
    const c = await lastKnownGood("k", 50, build);
    expect(c).toMatchObject({ body: { n: 1 }, stale: true, asOf: a.asOf });
    fail = false;
    await new Promise((r) => setTimeout(r, 60));
    const d = await lastKnownGood("k", 50, build);
    expect(d).toMatchObject({ body: { n: 2 }, stale: false });
  });

  it("fails (fast) when there is no previous body: never fabricates", async () => {
    await expect(lastKnownGood("empty", 50, () => Promise.reject(connectTimeout()))).rejects.toThrow(/timeout exceeded/);
  });

  it("propagates non-connectivity errors even with a previous body", async () => {
    let first = true;
    const build = async () => {
      if (first) return (first = false), { ok: true };
      throw sqlError();
    };
    await lastKnownGood("sql", 0, build);
    await expect(lastKnownGood("sql", 0, build)).rejects.toMatchObject({ code: "42P01" });
  });

  it("coalesces concurrent rebuilds into one", async () => {
    let builds = 0;
    const build = () => new Promise<{ b: number }>((r) => setTimeout(() => r({ b: ++builds }), 10));
    const rs = await Promise.all([1, 2, 3].map(() => lastKnownGood("co", 0, build)));
    expect(builds).toBe(1);
    expect(rs.every((r) => r.body.b === 1)).toBe(true);
  });
});
