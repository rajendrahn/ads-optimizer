import { describe, expect, it } from "vitest";
import {
  computeCalibrationCurve,
  computeCalibrationCurveForPoints,
  DEFAULT_CALIBRATION_BUCKET_WIDTH,
  MIN_CALIBRATION_BUCKET_SIZE,
} from "./calibrationCurve.ts";
import { must } from "./testSupport.ts";

describe("computeCalibrationCurve", () => {
  it("returns one empty (n=0, null rates) bucket per bin when given no points", () => {
    const buckets = computeCalibrationCurve([]);
    expect(buckets).toHaveLength(Math.round(1 / DEFAULT_CALIBRATION_BUCKET_WIDTH));
    for (const b of buckets) {
      expect(b.n).toBe(0);
      expect(b.meanPredictedConfidence).toBeNull();
      expect(b.observedSuccessRate).toBeNull();
    }
  });

  it("⚠️ refuses to report a rate from a bucket below the minimum — the exact requirement from the brief", () => {
    // Two points at confidence 0.85 — nowhere near MIN_CALIBRATION_BUCKET_SIZE (10). A Brier
    // score or calibration point "computed over zero, or three, evaluated outcomes is noise
    // wearing a number's clothes" — this must not draw a curve point from these two.
    const points = [
      { confidence: 0.85, success: true },
      { confidence: 0.85, success: false },
    ];
    const buckets = computeCalibrationCurve(points);
    const bucket = must(buckets.find((b) => b.bucketLow <= 0.85 && b.bucketHigh > 0.85));
    expect(bucket.n).toBe(2);
    expect(bucket.meanPredictedConfidence).toBeNull();
    expect(bucket.observedSuccessRate).toBeNull();
  });

  it("reports a real rate once a bucket clears the minimum", () => {
    const points = Array.from({ length: MIN_CALIBRATION_BUCKET_SIZE }, (_, i) => ({
      confidence: 0.8,
      success: i < 8, // 8/10 = 80% — a well-calibrated 0.8 bucket
    }));
    const buckets = computeCalibrationCurve(points);
    const bucket = must(buckets.find((b) => b.bucketLow <= 0.8 && b.bucketHigh > 0.8));
    expect(bucket.n).toBe(MIN_CALIBRATION_BUCKET_SIZE);
    expect(bucket.meanPredictedConfidence).toBeCloseTo(0.8, 10);
    expect(bucket.observedSuccessRate).toBeCloseTo(0.8, 10);
  });

  it("a confidence of exactly 1.0 falls in the last bucket, not an eleventh one", () => {
    const points = Array.from({ length: MIN_CALIBRATION_BUCKET_SIZE }, () => ({
      confidence: 1.0,
      success: true,
    }));
    const buckets = computeCalibrationCurve(points);
    expect(buckets).toHaveLength(10);
    const lastBucket = must(buckets[9]);
    expect(lastBucket.n).toBe(MIN_CALIBRATION_BUCKET_SIZE);
    expect(lastBucket.bucketLow).toBeCloseTo(0.9, 10);
    expect(lastBucket.bucketHigh).toBe(1);
  });

  it("honors a custom bucketWidth/minBucketSize", () => {
    const points = Array.from({ length: 3 }, () => ({ confidence: 0.5, success: true }));
    const buckets = computeCalibrationCurve(points, { bucketWidth: 0.5, minBucketSize: 3 });
    expect(buckets).toHaveLength(2);
    const bucket = must(buckets.find((b) => b.bucketLow <= 0.5 && b.bucketHigh > 0.5));
    expect(bucket.n).toBe(3);
    expect(bucket.observedSuccessRate).toBe(1);
  });

  it("throws on an out-of-[0,1] confidence rather than silently clamping", () => {
    expect(() => computeCalibrationCurve([{ confidence: 1.5, success: true }])).toThrow();
    expect(() => computeCalibrationCurve([{ confidence: -0.1, success: true }])).toThrow();
  });

  it("throws on an invalid bucketWidth", () => {
    expect(() => computeCalibrationCurve([], { bucketWidth: 0 })).toThrow();
    expect(() => computeCalibrationCurve([], { bucketWidth: 1.5 })).toThrow();
  });
});

describe("computeCalibrationCurveForPoints", () => {
  it("is a thin wrapper accepting tagged CalibrationPoints", () => {
    const buckets = computeCalibrationCurveForPoints([
      { id: "a", confidence: 0.8, success: true, source: "LIVE" },
    ]);
    const bucket = must(buckets.find((b) => b.bucketLow <= 0.8 && b.bucketHigh > 0.8));
    expect(bucket.n).toBe(1);
  });
});
