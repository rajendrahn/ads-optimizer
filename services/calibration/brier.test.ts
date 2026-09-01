import { describe, expect, it } from "vitest";
import { aggregateBrier, aggregateBrierForPoints, brierComponent } from "./brier.ts";
import type { CalibrationPoint } from "./types.ts";
import { must } from "./testSupport.ts";

describe("brierComponent", () => {
  it("is 0 for a perfectly confident, correct call", () => {
    expect(brierComponent(1, true)).toBe(0);
    expect(brierComponent(0, false)).toBe(0);
  });

  it("is 1 for a perfectly confident, wrong call", () => {
    expect(brierComponent(1, false)).toBe(1);
    expect(brierComponent(0, true)).toBe(1);
  });

  it("is 0.25 for a coin-flip confidence, either outcome", () => {
    expect(brierComponent(0.5, true)).toBeCloseTo(0.25, 10);
    expect(brierComponent(0.5, false)).toBeCloseTo(0.25, 10);
  });

  it("matches services/backtest/outcome.ts's own formula: (confidence - actual)^2", () => {
    expect(brierComponent(0.8, true)).toBeCloseTo((0.8 - 1) ** 2, 10);
    expect(brierComponent(0.8, false)).toBeCloseTo((0.8 - 0) ** 2, 10);
  });
});

describe("aggregateBrier", () => {
  it("returns n=0, meanBrier=null for an empty set — never 0 or NaN", () => {
    const result = aggregateBrier([]);
    expect(result.n).toBe(0);
    expect(result.meanBrier).toBeNull();
  });

  it("averages components over multiple points", () => {
    const result = aggregateBrier([
      { confidence: 1, success: true }, // 0
      { confidence: 1, success: false }, // 1
    ]);
    expect(result.n).toBe(2);
    expect(result.meanBrier).toBeCloseTo(0.5, 10);
  });

  it("a well-calibrated set (0.8 confidence, succeeds ~80% of the time) scores well", () => {
    const points = [
      ...Array.from({ length: 8 }, () => ({ confidence: 0.8, success: true })),
      ...Array.from({ length: 2 }, () => ({ confidence: 0.8, success: false })),
    ];
    const result = aggregateBrier(points);
    // 8 * (0.2^2) + 2 * (0.8^2) = 8*0.04 + 2*0.64 = 0.32 + 1.28 = 1.6; /10 = 0.16
    expect(result.meanBrier).toBeCloseTo(0.16, 10);
  });

  it("a badly-calibrated set (0.9 confidence, succeeds only 50% of the time) scores worse", () => {
    const wellCalibrated = aggregateBrier([
      ...Array.from({ length: 5 }, () => ({ confidence: 0.5, success: true })),
      ...Array.from({ length: 5 }, () => ({ confidence: 0.5, success: false })),
    ]);
    const overconfident = aggregateBrier([
      ...Array.from({ length: 5 }, () => ({ confidence: 0.9, success: true })),
      ...Array.from({ length: 5 }, () => ({ confidence: 0.9, success: false })),
    ]);
    expect(must(overconfident.meanBrier)).toBeGreaterThan(must(wellCalibrated.meanBrier));
  });
});

describe("aggregateBrierForPoints", () => {
  it("is a thin wrapper over aggregateBrier for tagged CalibrationPoints", () => {
    const points: CalibrationPoint[] = [
      { id: "a", confidence: 0.7, success: true, source: "LIVE" },
      { id: "b", confidence: 0.3, success: false, source: "BACKTEST_SYSTEM" },
    ];
    const result = aggregateBrierForPoints(points);
    expect(result.n).toBe(2);
    expect(result.meanBrier).toBeCloseTo(
      (brierComponent(0.7, true) + brierComponent(0.3, false)) / 2,
      10,
    );
  });
});
