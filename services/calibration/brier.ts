// E3 — the Brier score (§29 criterion 11: "Confidence is calibrated — Brier score improving").
//
// The Brier score for one prediction is the squared error between a stated probability and the
// binary outcome it was a probability OF: (confidence - actual)^2, actual ∈ {0, 1}. It is the
// standard proper scoring rule for "is this model's stated confidence honest" — a model that
// says 0.8 and is right 80% of the time scores well; a model that says 0.8 and is right 50% of
// the time scores worse than one that had honestly said 0.5. This file computes it; it does not
// decide WHICH recommendations are eligible to be scored (report.ts's job) or what counts as
// "success" (E1's `scaledSuccessfully` / E2's `classification`, both upstream of this file).

import type { BrierResult, CalibrationPoint } from "./types.ts";

/** The Brier component for a single prediction: (confidence - actual)^2, `actual` = 1 if
 * `success`, else 0. Matches `services/backtest/outcome.ts`'s own `computeBrierScoreComponent`
 * formula exactly (E1), so a live point and a backtest point are combined on the same scale. */
export function brierComponent(confidence: number, success: boolean): number {
  const actual = success ? 1 : 0;
  const diff = confidence - actual;
  return diff * diff;
}

/** Mean Brier score over a set of points. `n: 0` → `meanBrier: null` — never `0` or `NaN`, which
 * would both read as "perfectly calibrated" rather than "nothing to score yet". This is the same
 * honesty discipline C5's `demandIndex` applies at n below its own floor, just at the n=0 boundary
 * instead of n<2 — a mean of zero things is not a zero, it is nothing. */
export function aggregateBrier(
  points: readonly { confidence: number; success: boolean }[],
): BrierResult {
  if (points.length === 0) return { n: 0, meanBrier: null };
  const sum = points.reduce((acc, p) => acc + brierComponent(p.confidence, p.success), 0);
  return { n: points.length, meanBrier: sum / points.length };
}

/** Convenience wrapper over `CalibrationPoint[]`, for callers already holding the tagged shape
 * (report.ts). Identical to `aggregateBrier` — kept as a separate named export so a call site
 * reads as "score these calibration points" rather than "score these generic {confidence,
 * success} pairs", nothing more. */
export function aggregateBrierForPoints(points: readonly CalibrationPoint[]): BrierResult {
  return aggregateBrier(points);
}
