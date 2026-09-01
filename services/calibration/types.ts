// Shared types for E3 (confidence calibration, §29 criteria 11/12). Kept in one place because
// brier.ts, calibrationCurve.ts, rejectionRate.ts and report.ts all share the same notion of "one
// scored point" and "one time-bucketed rejection count" — see each file's own module comment for
// how a point is produced.

/** One judged, binary-outcome recommendation: a stated confidence and whether it succeeded.
 * `source` says which stream it came from — a live `recommendationOutcomes` doc (E2) or a
 * `backtestRuns` SYSTEM-strategy row (E1) — because the two streams define "success" slightly
 * differently upstream (see report.ts's own module comment) and every consumer of a pooled list
 * of points must be able to break it back out by source rather than treat the pool as
 * homogeneous. */
export interface CalibrationPoint {
  id: string;
  confidence: number;
  success: boolean;
  source: "LIVE" | "BACKTEST_SYSTEM";
}

/** The result of scoring a set of points with the Brier score (mean squared error between stated
 * confidence and the binary 0/1 outcome — lower is better, 0 is perfect, 0.25 is what a
 * constant-0.5 forecaster gets). `n` is always reported, even when `meanBrier` is `null` — the
 * "no real data yet" case still has a truthful `n: 0` rather than reading like a total absence of
 * a metric. */
export interface BrierResult {
  n: number;
  meanBrier: number | null;
}
