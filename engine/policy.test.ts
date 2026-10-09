import { beforeEach, describe, expect, it } from "vitest";
import { backoffMs, DEFAULT_POLICY, isCooling, isRetryable, noteAttempt, orderByHealth, parsePolicy, resetProviderHealth } from "./policy";

describe("gateway policy", () => {
  beforeEach(() => resetProviderHealth());

  it("parses from a brain object or top level, clamps, and ignores junk", () => {
    expect(parsePolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(parsePolicy({ retries: 5, fallback: false, timeout_ms: 500 })).toEqual({ retries: 2, fallback: false, timeoutMs: 1_000 });
    expect(parsePolicy({ brain: { retries: 0, timeout_ms: 20_000 } })).toEqual({ retries: 0, fallback: true, timeoutMs: 20_000 });
    expect(parsePolicy({ retries: "lots", fallback: "no", timeout_ms: -1 })).toEqual(DEFAULT_POLICY);
    expect(parsePolicy({ retries: 1.5 })).toEqual(DEFAULT_POLICY);
  });

  it("classifies transient vs. request errors", () => {
    for (const e of ["timeout", "unreachable", "upstream 500", "upstream 503", "upstream 429", "upstream 408", "node did not start in time", undefined]) expect(isRetryable(e)).toBe(true);
    for (const e of ["upstream 400", "upstream 401", "upstream 402", "upstream 404", "upstream 413", "privacy PRIVATE excludes third-party", "native network: no node serves an allowlisted model", "unsupported request kind", "payload_too_large"]) expect(isRetryable(e)).toBe(false);
  });

  it("backs off exponentially with jitter, capped", () => {
    expect(backoffMs(0, () => 0)).toBe(200);
    expect(backoffMs(1, () => 0)).toBe(400);
    expect(backoffMs(2, () => 0.99)).toBe(899);
    expect(backoffMs(6, () => 0)).toBe(1_500);
  });

  it("cools a provider after three consecutive transient failures, ranks it last, recovers on success or time", () => {
    const t = 1_000_000;
    noteAttempt("a", false, "timeout", t);
    noteAttempt("a", false, "upstream 503", t + 10);
    expect(isCooling("a", t + 20)).toBe(false);
    noteAttempt("a", false, "unreachable", t + 20);
    expect(isCooling("a", t + 30)).toBe(true);
    expect(orderByHealth([{ provider: "a" }, { provider: "b" }], t + 30).map((x) => x.provider)).toEqual(["b", "a"]);
    expect(isCooling("a", t + 31_000)).toBe(false);
    noteAttempt("a", false, "timeout", t + 40);
    expect(isCooling("a", t + 50)).toBe(true);
    noteAttempt("a", true, undefined, t + 60);
    expect(isCooling("a", t + 70)).toBe(false);
  });

  it("non-transient failures never trip the cooldown", () => {
    for (let i = 0; i < 5; i++) noteAttempt("x", false, "upstream 400");
    expect(isCooling("x")).toBe(false);
  });
});
