import { describe, expect, it } from "vitest";
import { shrinkTowardAccountMean } from "./shrinkage.ts";

/** Avoids `!` (banned by this repo's lint config) at call sites that already know — from the
 * test's own inputs (a non-null raw value and account mean) — that the result cannot be null. */
function requireNumber(x: number | null): number {
  if (x === null) throw new Error("expected a non-null shrunk value");
  return x;
}

describe("shrinkTowardAccountMean", () => {
  it("pulls a small-sample outlier strongly toward the account mean — the step's own 'done when' bar", () => {
    // A lucky small sample: 5 purchases, raw ROAS 8.0, account mean 2.5, pseudo-count 30.
    const shrunk = requireNumber(shrinkTowardAccountMean(8.0, 5, 2.5, 30));
    // weight = 5 / (5 + 30) = 1/7 ~= 0.142857
    const expected = (5 / 35) * 8.0 + (30 / 35) * 2.5;
    expect(shrunk).toBeCloseTo(expected, 10);
    expect(shrunk).toBeCloseTo(3.2857142857, 6);
    // Moved substantially toward the mean, and stayed on the correct side of it.
    expect(shrunk).toBeLessThan(8.0);
    expect(shrunk).toBeGreaterThan(2.5);
    // "By a defensible amount": pulled most of the way (>55%) from raw toward the mean, not a
    // token nudge.
    const totalGap = 8.0 - 2.5;
    const movedBy = 8.0 - shrunk;
    expect(movedBy / totalGap).toBeGreaterThan(0.55);
  });

  it("barely moves a high-volume entity's number — n >> pseudoCount", () => {
    const shrunk = requireNumber(shrinkTowardAccountMean(4.0, 5000, 2.5, 30));
    // weight = 5000/5030 ~= 0.9940
    expect(shrunk).toBeGreaterThan(3.99);
    expect(shrunk).toBeLessThan(4.0);
  });

  it("shrinks all the way to the account mean at n=0", () => {
    expect(shrinkTowardAccountMean(9.0, 0, 2.5, 30)).toBeCloseTo(2.5, 10);
  });

  it("is a no-op when the raw value already equals the account mean, at any n", () => {
    expect(shrinkTowardAccountMean(2.5, 3, 2.5, 30)).toBeCloseTo(2.5, 10);
    expect(shrinkTowardAccountMean(2.5, 300, 2.5, 30)).toBeCloseTo(2.5, 10);
  });

  it("returns null when there is nothing to shrink or nothing to shrink toward", () => {
    expect(shrinkTowardAccountMean(null, 10, 2.5, 30)).toBeNull();
    expect(shrinkTowardAccountMean(4.0, 10, null, 30)).toBeNull();
    expect(shrinkTowardAccountMean(null, 10, null, 30)).toBeNull();
  });

  it("shrinks an entity sitting exactly at the pseudo-count halfway to the mean", () => {
    const shrunk = shrinkTowardAccountMean(6.0, 30, 2.0, 30);
    expect(shrunk).toBeCloseTo((6.0 + 2.0) / 2, 10);
  });
});
