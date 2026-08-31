// The estimator, §15.3's own instruction: "keep it simple and explainable... describe it in the
// packet text." In two plain sentences: we treat the number of purchases behind a window's
// ROAS/CPA figure as a Poisson-distributed count and build a confidence interval on that count
// using the Anscombe (1948) square-root variance-stabilizing transform — a closed-form
// approximation, no external stats library, no gamma/chi-square quantile function, just
// arithmetic; because ROAS scales up (and CPA scales down) linearly with that same purchase
// count for a fixed spend figure within one window, the purchase-count interval's relative width
// carries straight over onto both.
//
// Why Anscombe's transform specifically, over the more commonly-taught Wald interval
// (n ± z*sqrt(n)): the Wald interval can go negative for a small count, which is nonsensical for
// a purchase count and would need an ad-hoc clip; Anscombe's sqrt(n + 3/8) is a well-known,
// closed-form correction (still just one square root and one addition) that keeps the interval
// non-negative by construction and has materially better coverage at the small sample sizes
// (§2.1: 4-8 purchases/ad/week) this account actually produces.

export interface CountInterval {
  low: number;
  high: number;
}

/**
 * A minimum interval half-width (in purchase-count units) applied to the LOW bound only, after
 * squaring back. Purely a numerical safety net: `poissonCountInterval` cannot in practice return
 * a `low` of exactly 0 for n >= 1 at the z-scores this system uses (see the module-level note in
 * windowStatistics.ts's tests for the derivation), but a future config change to a much larger
 * `intervalZScore` could push it there — and dividing an inverse metric like CPA by exactly 0
 * would produce `Infinity`, which Firestore rejects outright as a stored value. This floor turns
 * that failure into a very wide (but finite, storable) interval instead of a write-time crash.
 */
const MIN_LOW_COUNT_SQUARED = 0.01;

/**
 * Anscombe's square-root approximation to a Poisson confidence interval. `z` is the two-sided
 * z-score for the desired confidence level (e.g. 1.645 ~= 90%, 1.96 ~= 95%) — see
 * shared/canon/statisticalThresholds.ts's `intervalZScore`.
 *
 * Returns `null` for `n === 0`: a zero-purchase window is a real, exact observation, not an
 * absence of one, but there is no honest ratio-based interval to build from zero events — callers
 * should treat `n === 0` as its own case (see windowStatistics.ts's `evaluateMetric`), not as
 * "no interval could be computed" in the sense this function's other `null` (invalid input) is.
 */
export function poissonCountInterval(n: number, z: number): CountInterval | null {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return null;
  if (!Number.isFinite(z) || z <= 0) return null;

  const stabilized = Math.sqrt(n + 0.375); // Anscombe's 3/8 continuity correction
  const lowRoot = Math.max(0, stabilized - z / 2);
  const highRoot = stabilized + z / 2;

  const low = Math.max(lowRoot * lowRoot, MIN_LOW_COUNT_SQUARED);
  const high = highRoot * highRoot;
  return { low, high };
}

/**
 * Scales a point value (ROAS or CPA) by the same ratio the purchase-count interval implies
 * relative to the observed count `n`. Valid because, within one already-computed window, both
 * ROAS (purchase value / fixed spend) and CPA (fixed spend / purchase count) are — to first
 * order — linear functions of the purchase count alone: ROAS moves in the same direction as the
 * count (more purchases, more attributed value, for a roughly stable average order value); CPA
 * moves in the opposite direction (more purchases divides the same spend more ways).
 *
 * This is a documented simplification, not a claim that average order value has zero variance —
 * see this module's own header comment and this step's report for why a more sophisticated model
 * (e.g. separately modelling order-value variance) was deliberately not built: the brief's own
 * bar is an estimator simple enough to describe in the packet text a model reasons over, and
 * "the interval scales with how many purchases we saw" clears that bar; a compound model would
 * not.
 */
export function scaleIntervalByCount(
  pointValue: number,
  n: number,
  countInterval: CountInterval,
  direction: "increasingWithCount" | "decreasingWithCount",
): CountInterval {
  if (direction === "increasingWithCount") {
    return {
      low: (pointValue * countInterval.low) / n,
      high: (pointValue * countInterval.high) / n,
    };
  }
  // decreasingWithCount (CPA): more purchases in the plausible range -> lower CPA, so the
  // count interval's LOW bound produces CPA's HIGH bound and vice versa.
  return {
    low: (pointValue * n) / countInterval.high,
    high: (pointValue * n) / countInterval.low,
  };
}
