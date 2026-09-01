// E3 — the calibration (reliability) curve: "do 0.8-confidence recommendations succeed roughly
// 80% of the time?" (§29 criterion 11, IMPLEMENTATION_PLAN.md E3). Buckets points by their stated
// confidence into fixed-width bins and compares each bin's mean stated confidence against its
// observed success rate.
//
// ⚠️ The orchestrator brief's own instruction, followed literally here: "refuse to emit a
// calibration curve below a stated minimum bucket size rather than drawing one from two points."
// A bucket below `minBucketSize` still reports its `n` (so the report is honest about how thin
// the evidence is) but `meanPredictedConfidence`/`observedSuccessRate` are `null`, not a number
// computed from too few points — the same shape C5's `demandIndex` uses for `n < 2`
// (`services/analytics/seasonality/demandIndex.ts`), just at a different, documented floor
// appropriate to a success-rate proportion rather than a demand ratio.

import type { CalibrationPoint } from "./types.ts";

/** Bucket width for the reliability diagram, in confidence units (0..1). 0.1 gives ten buckets —
 * the standard reliability-diagram convention, and the one that directly answers "do 0.8-ish
 * calls succeed about 80% of the time" without rounding two different tenths together. */
export const DEFAULT_CALIBRATION_BUCKET_WIDTH = 0.1;

/** The minimum number of judged points a bucket needs before its rate is reported as a number
 * rather than `null`. This is a documented, adjustable placeholder — like C5's
 * `MIN_SAMPLE_SIZE_FOR_INDEX` and D5's `DEFAULT_MAX_CHANGE_PERCENT` — not a value derived from
 * this account's data (there is currently none to derive it from). 10 is a conservative floor for
 * eyeballing a proportion; whoever owns this report once real outcomes exist should revisit it
 * once there is real variance to tune against. */
export const MIN_CALIBRATION_BUCKET_SIZE = 10;

export interface CalibrationBucket {
  bucketLow: number;
  bucketHigh: number;
  /** How many judged points fall in this bucket — always reported, even when below
   * `minBucketSize`. This is the number that makes a suppressed bucket auditable rather than just
   * missing. */
  n: number;
  /** The mean of the points' own stated confidence in this bucket. `null` when `n <
   * minBucketSize`. */
  meanPredictedConfidence: number | null;
  /** The observed fraction that succeeded. `null` when `n < minBucketSize`. */
  observedSuccessRate: number | null;
}

export interface ComputeCalibrationCurveOptions {
  bucketWidth?: number;
  minBucketSize?: number;
}

/** Assigns a confidence value in [0,1] to a bucket index for the given width. Confidence exactly
 * 1.0 lands in the last bucket rather than spilling into a nonexistent eleventh one. */
function bucketIndexFor(confidence: number, bucketWidth: number, bucketCount: number): number {
  const raw = Math.floor(confidence / bucketWidth);
  return Math.max(0, Math.min(raw, bucketCount - 1));
}

/** Builds the reliability diagram's underlying bucket data. Points with `confidence` outside
 * [0,1] are rejected loudly (a calibration curve over an invalid probability is a bug upstream,
 * not something to silently clamp) — `recommendationSchema.confidence` is already
 * `z.number().min(0).max(1).nullable()`, so a caller passing a parsed recommendation's confidence
 * should never actually hit this. */
export function computeCalibrationCurve(
  points: readonly { confidence: number; success: boolean }[],
  options: ComputeCalibrationCurveOptions = {},
): CalibrationBucket[] {
  const bucketWidth = options.bucketWidth ?? DEFAULT_CALIBRATION_BUCKET_WIDTH;
  const minBucketSize = options.minBucketSize ?? MIN_CALIBRATION_BUCKET_SIZE;
  if (!(bucketWidth > 0) || bucketWidth > 1) {
    throw new Error(`computeCalibrationCurve: bucketWidth must be in (0, 1], got ${bucketWidth}`);
  }
  const bucketCount = Math.round(1 / bucketWidth);

  const buckets: { confidences: number[]; successes: boolean[] }[] = Array.from(
    { length: bucketCount },
    () => ({ confidences: [], successes: [] }),
  );

  for (const p of points) {
    if (Number.isNaN(p.confidence) || p.confidence < 0 || p.confidence > 1) {
      throw new Error(`computeCalibrationCurve: confidence out of [0,1] range: ${p.confidence}`);
    }
    const idx = bucketIndexFor(p.confidence, bucketWidth, bucketCount);
    const bucket = buckets[idx];
    if (!bucket) {
      throw new Error(`computeCalibrationCurve: internal error — bucket index ${idx} out of range`);
    }
    bucket.confidences.push(p.confidence);
    bucket.successes.push(p.success);
  }

  return buckets.map((bucket, idx) => {
    const n = bucket.confidences.length;
    const bucketLow = idx * bucketWidth;
    const bucketHigh = idx === bucketCount - 1 ? 1 : (idx + 1) * bucketWidth;
    if (n < minBucketSize) {
      return { bucketLow, bucketHigh, n, meanPredictedConfidence: null, observedSuccessRate: null };
    }
    const meanPredictedConfidence = bucket.confidences.reduce((a, b) => a + b, 0) / n;
    const observedSuccessRate = bucket.successes.filter(Boolean).length / n;
    return { bucketLow, bucketHigh, n, meanPredictedConfidence, observedSuccessRate };
  });
}

/** Convenience wrapper over `CalibrationPoint[]`, mirroring `aggregateBrierForPoints`. */
export function computeCalibrationCurveForPoints(
  points: readonly CalibrationPoint[],
  options?: ComputeCalibrationCurveOptions,
): CalibrationBucket[] {
  return computeCalibrationCurve(points, options);
}
