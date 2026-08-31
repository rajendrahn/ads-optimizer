// Barrel for C3's statistics layer (§15).

export { poissonCountInterval, scaleIntervalByCount, type CountInterval } from "./interval.ts";
export { computeVerdict, type Verdict } from "./verdict.ts";
export { shrinkTowardAccountMean } from "./shrinkage.ts";
export {
  computeWindowStatistics,
  type AccountMeansForWindow,
  type WindowStatisticalThresholds,
  type MetricStatPatch,
  type WindowStatisticsPatch,
} from "./windowStatistics.ts";
export {
  computeStatisticsHandler,
  computeStatisticsRegistration,
  type ComputeStatisticsPayload,
} from "./computeStatisticsTask.ts";
