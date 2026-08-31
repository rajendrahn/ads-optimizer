import { describe, expect, it } from "vitest";
import { combineGapVerdicts, markGap, unsafeIgnoreGap } from "./gapAware.ts";

describe("markGap", () => {
  it("wraps a value with its gap verdict", () => {
    const wrapped = markGap({ total: 5 }, true, ["2026-08-01"]);
    expect(wrapped).toEqual({
      value: { total: 5 },
      windowHasDataGap: true,
      gapDays: ["2026-08-01"],
    });
  });
});

describe("unsafeIgnoreGap", () => {
  it("returns the plain value when a justification is supplied", () => {
    const wrapped = markGap(42, false, []);
    expect(unsafeIgnoreGap(wrapped, "displayed alongside the gap flag in the UI")).toBe(42);
  });

  it("throws when the justification is empty or whitespace-only — cannot be called silently", () => {
    const wrapped = markGap(42, false, []);
    expect(() => unsafeIgnoreGap(wrapped, "")).toThrow(/justification/);
    expect(() => unsafeIgnoreGap(wrapped, "   ")).toThrow(/justification/);
  });
});

describe("combineGapVerdicts", () => {
  it("is gap-affected if ANY input is, unioning gap days", () => {
    const combined = combineGapVerdicts([
      { windowHasDataGap: false, gapDays: [] },
      { windowHasDataGap: true, gapDays: ["2026-01-02", "2026-01-01"] },
    ]);
    expect(combined.windowHasDataGap).toBe(true);
    expect(combined.gapDays).toEqual(["2026-01-01", "2026-01-02"]);
  });

  it("is not gap-affected when no input is", () => {
    const combined = combineGapVerdicts([
      { windowHasDataGap: false, gapDays: [] },
      { windowHasDataGap: false, gapDays: [] },
    ]);
    expect(combined.windowHasDataGap).toBe(false);
    expect(combined.gapDays).toEqual([]);
  });

  it("dedupes overlapping gap days across inputs", () => {
    const combined = combineGapVerdicts([
      { windowHasDataGap: true, gapDays: ["2026-01-01"] },
      { windowHasDataGap: true, gapDays: ["2026-01-01", "2026-01-02"] },
    ]);
    expect(combined.gapDays).toEqual(["2026-01-01", "2026-01-02"]);
  });
});
