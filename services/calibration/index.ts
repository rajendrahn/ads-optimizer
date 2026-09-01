// Barrel for E3's confidence calibration (§29 criteria 11/12, IMPLEMENTATION_PLAN.md E3).

export { brierComponent, aggregateBrier, aggregateBrierForPoints } from "./brier.ts";
export {
  computeCalibrationCurve,
  computeCalibrationCurveForPoints,
  DEFAULT_CALIBRATION_BUCKET_WIDTH,
  MIN_CALIBRATION_BUCKET_SIZE,
  type CalibrationBucket,
  type ComputeCalibrationCurveOptions,
} from "./calibrationCurve.ts";
export {
  computeRejectionRateOverTime,
  computeOverallRejectionRate,
  summarizeGuardrailViolations,
  type RejectionRateGranularity,
  type RejectionRatePeriod,
  type OverallRejectionRate,
  type ViolationCodeCount,
  type JudgedAgainstSourceCount,
  type JudgedAgainstFieldSummary,
  type GuardrailViolationSummary,
} from "./rejectionRate.ts";
export { collectCalibrationInputs, type CalibrationRawInputs } from "./collect.ts";
export {
  buildCalibrationReport,
  type CalibrationReport,
  type CalibrationReportCanon,
  type LiveOutcomesSummary,
  type BacktestSummary,
  type UnjudgedSummary,
  type CalibrationCurveSection,
  type GuardrailRejectionRateSection,
} from "./report.ts";
export { renderCalibrationDashboard } from "./dashboardHtml.ts";
export type { BrierResult, CalibrationPoint } from "./types.ts";
