import { describe, expect, it, vi } from "vitest";
import { decideBucBackoff, parseBucHeader, type ParsedBucUsage } from "./buc.ts";

/** Test-only helper: asserts non-null via a runtime check rather than the `!` operator, so
 * ESLint's `no-non-null-assertion` (strict config) doesn't have to be overridden per call. */
function parseOrThrow(header: string): ParsedBucUsage {
  const parsed = parseBucHeader(header);
  if (!parsed) throw new Error(`expected parseBucHeader to return usage for: ${header}`);
  return parsed;
}

describe("parseBucHeader", () => {
  it("returns null for a missing header", () => {
    expect(parseBucHeader(null)).toBeNull();
    expect(parseBucHeader(undefined)).toBeNull();
    expect(parseBucHeader("")).toBeNull();
    expect(parseBucHeader("   ")).toBeNull();
  });

  it("parses a single-key, single-entry header (the common real-world shape)", () => {
    const header = JSON.stringify({
      act_456833154967349: [
        {
          type: "ads_insights",
          call_count: 28,
          total_cputime: 25,
          total_time: 22,
          estimated_time_to_regain_access: 0,
        },
      ],
    });

    const parsed = parseOrThrow(header);

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({
      key: "act_456833154967349",
      type: "ads_insights",
      callCount: 28,
      totalCpuTime: 25,
      totalTime: 22,
      estimatedTimeToRegainAccess: 0,
    });
    expect(parsed.maxUsagePercent).toBe(28);
    expect(parsed.maxEstimatedMinutesToRegainAccess).toBe(0);
  });

  it("takes the max across call_count/total_cputime/total_time within one entry", () => {
    const header = JSON.stringify({
      act_1: [{ call_count: 10, total_cputime: 87, total_time: 40 }],
    });

    expect(parseOrThrow(header).maxUsagePercent).toBe(87);
  });

  it("takes the max across multiple entries under one key", () => {
    const header = JSON.stringify({
      act_1: [
        { type: "ads_insights", call_count: 30, total_cputime: 20, total_time: 20 },
        { type: "ads_management", call_count: 91, total_cputime: 10, total_time: 10 },
      ],
    });

    expect(parseOrThrow(header).maxUsagePercent).toBe(91);
  });

  it("takes the max across multiple top-level keys (multiple business/account IDs)", () => {
    const header = JSON.stringify({
      act_1: [{ call_count: 40, total_cputime: 40, total_time: 40 }],
      biz_2: [{ call_count: 96, total_cputime: 10, total_time: 10 }],
    });

    const parsed = parseOrThrow(header);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.maxUsagePercent).toBe(96);
  });

  it("surfaces estimated_time_to_regain_access when Meta has already started throttling", () => {
    const header = JSON.stringify({
      act_1: [
        {
          call_count: 100,
          total_cputime: 100,
          total_time: 100,
          estimated_time_to_regain_access: 12,
        },
      ],
    });

    expect(parseOrThrow(header).maxEstimatedMinutesToRegainAccess).toBe(12);
  });

  it("returns null and logs a warning for malformed JSON, without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => parseBucHeader("{not valid json")).not.toThrow();
    expect(parseBucHeader("{not valid json")).toBeNull();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it("returns null for a JSON value that isn't an object (e.g. an array or a number)", () => {
    expect(parseBucHeader("[1,2,3]")).toBeNull();
    expect(parseBucHeader("42")).toBeNull();
    expect(parseBucHeader("null")).toBeNull();
  });

  it("returns null when the object has no array-valued keys with usable entries", () => {
    expect(parseBucHeader(JSON.stringify({ act_1: "not-an-array" }))).toBeNull();
    expect(parseBucHeader(JSON.stringify({}))).toBeNull();
  });

  it("treats missing/non-numeric fields within an entry as 0 rather than crashing", () => {
    const header = JSON.stringify({ act_1: [{ type: "ads_insights" }] });
    const parsed = parseOrThrow(header);

    expect(parsed.entries[0]).toMatchObject({
      callCount: 0,
      totalCpuTime: 0,
      totalTime: 0,
      estimatedTimeToRegainAccess: 0,
    });
    expect(parsed.maxUsagePercent).toBe(0);
  });
});

describe("decideBucBackoff", () => {
  it("does not throttle when there is no usage data yet (first request)", () => {
    const decision = decideBucBackoff(null);
    expect(decision.shouldThrottle).toBe(false);
    expect(decision.waitMs).toBe(0);
  });

  it("does not throttle comfortably below the threshold", () => {
    const usage = parseOrThrow(JSON.stringify({ act_1: [{ call_count: 40 }] }));
    const decision = decideBucBackoff(usage);
    expect(decision.shouldThrottle).toBe(false);
  });

  it("does not throttle just under the default 90% threshold", () => {
    const usage = parseOrThrow(JSON.stringify({ act_1: [{ call_count: 89 }] }));
    expect(decideBucBackoff(usage).shouldThrottle).toBe(false);
  });

  it("throttles at exactly the default 90% threshold", () => {
    const usage = parseOrThrow(JSON.stringify({ act_1: [{ call_count: 90 }] }));
    const decision = decideBucBackoff(usage);
    expect(decision.shouldThrottle).toBe(true);
    expect(decision.waitMs).toBeGreaterThan(0);
  });

  it("waits longer at 95% than at 90%, and longer still at 100%", () => {
    const at90 = decideBucBackoff(parseOrThrow(JSON.stringify({ act_1: [{ call_count: 90 }] })));
    const at95 = decideBucBackoff(parseOrThrow(JSON.stringify({ act_1: [{ call_count: 95 }] })));
    const at100 = decideBucBackoff(parseOrThrow(JSON.stringify({ act_1: [{ call_count: 100 }] })));

    expect(at95.waitMs).toBeGreaterThan(at90.waitMs);
    expect(at100.waitMs).toBeGreaterThan(at95.waitMs);
  });

  it("respects a custom threshold", () => {
    const usage = parseOrThrow(JSON.stringify({ act_1: [{ call_count: 60 }] }));
    expect(decideBucBackoff(usage, { thresholdPercent: 50 }).shouldThrottle).toBe(true);
    expect(decideBucBackoff(usage, { thresholdPercent: 70 }).shouldThrottle).toBe(false);
  });

  it("uses estimated_time_to_regain_access, capped at 15 minutes, once Meta is already throttling", () => {
    const usage = parseOrThrow(
      JSON.stringify({ act_1: [{ call_count: 100, estimated_time_to_regain_access: 5 }] }),
    );
    const decision = decideBucBackoff(usage);
    expect(decision.shouldThrottle).toBe(true);
    expect(decision.waitMs).toBe(5 * 60_000);
  });

  it("caps the estimated_time_to_regain_access wait at 15 minutes even if Meta reports more", () => {
    const usage = parseOrThrow(
      JSON.stringify({ act_1: [{ call_count: 100, estimated_time_to_regain_access: 120 }] }),
    );
    expect(decideBucBackoff(usage).waitMs).toBe(15 * 60_000);
  });
});
