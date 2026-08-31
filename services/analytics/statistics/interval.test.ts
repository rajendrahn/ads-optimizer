import { describe, expect, it } from "vitest";
import { poissonCountInterval, scaleIntervalByCount, type CountInterval } from "./interval.ts";

const Z90 = 1.645;

/** Avoids `!` (banned by this repo's lint config) at call sites that already know — from the
 * test's own setup — that the interval cannot be null. */
function requireInterval(n: number, z: number): CountInterval {
  const interval = poissonCountInterval(n, z);
  if (interval === null) throw new Error(`expected a real interval for n=${n}, z=${z}`);
  return interval;
}

describe("poissonCountInterval", () => {
  it("returns null for n=0 — a real zero observation has no honest ratio-based interval", () => {
    expect(poissonCountInterval(0, Z90)).toBeNull();
  });

  it("returns null for invalid inputs (negative, NaN, Infinity, non-positive z)", () => {
    expect(poissonCountInterval(-1, Z90)).toBeNull();
    expect(poissonCountInterval(Number.NaN, Z90)).toBeNull();
    expect(poissonCountInterval(Number.POSITIVE_INFINITY, Z90)).toBeNull();
    expect(poissonCountInterval(10, 0)).toBeNull();
    expect(poissonCountInterval(10, -1)).toBeNull();
  });

  it("brackets n for a range of realistic sample sizes (1, 5, 30, 150)", () => {
    for (const n of [1, 5, 30, 150]) {
      const interval = requireInterval(n, Z90);
      expect(interval.low).toBeLessThanOrEqual(n);
      expect(interval.high).toBeGreaterThanOrEqual(n);
      expect(interval.low).toBeGreaterThanOrEqual(0);
    }
  });

  it("relative width shrinks as n grows — more purchases, tighter interval", () => {
    const small = requireInterval(5, Z90);
    const large = requireInterval(150, Z90);
    const relativeWidth = (i: { low: number; high: number }, n: number) => (i.high - i.low) / n;
    expect(relativeWidth(large, 150)).toBeLessThan(relativeWidth(small, 5));
  });

  it("matches Anscombe's closed form exactly for a hand-computed case (n=30, z=1.645)", () => {
    const interval = requireInterval(30, Z90);
    const stabilized = Math.sqrt(30 + 0.375);
    const lowRoot = stabilized - Z90 / 2;
    const highRoot = stabilized + Z90 / 2;
    expect(interval.low).toBeCloseTo(lowRoot * lowRoot, 8);
    expect(interval.high).toBeCloseTo(highRoot * highRoot, 8);
  });

  it("never returns a low bound of exactly 0 for n >= 1 at realistic z-scores (division-by-zero guard)", () => {
    for (const n of [1, 2, 3]) {
      const interval = requireInterval(n, Z90);
      expect(interval.low).toBeGreaterThan(0);
    }
  });
});

describe("scaleIntervalByCount", () => {
  it("scales up proportionally for an increasing-with-count metric (ROAS)", () => {
    const scaled = scaleIntervalByCount(3.0, 30, { low: 20, high: 40 }, "increasingWithCount");
    expect(scaled.low).toBeCloseTo(2.0, 10);
    expect(scaled.high).toBeCloseTo(4.0, 10);
  });

  it("scales inversely for a decreasing-with-count metric (CPA) — low count-bound -> high CPA", () => {
    const scaled = scaleIntervalByCount(100, 30, { low: 20, high: 40 }, "decreasingWithCount");
    expect(scaled.low).toBeCloseTo(75, 10); // 100 * 30 / 40
    expect(scaled.high).toBeCloseTo(150, 10); // 100 * 30 / 20
  });

  it("the point value always sits within its own scaled interval", () => {
    const countInterval = requireInterval(12, Z90);
    const roas = scaleIntervalByCount(2.4, 12, countInterval, "increasingWithCount");
    expect(roas.low).toBeLessThanOrEqual(2.4);
    expect(roas.high).toBeGreaterThanOrEqual(2.4);

    const cpa = scaleIntervalByCount(50000, 12, countInterval, "decreasingWithCount");
    expect(cpa.low).toBeLessThanOrEqual(50000);
    expect(cpa.high).toBeGreaterThanOrEqual(50000);
  });
});
