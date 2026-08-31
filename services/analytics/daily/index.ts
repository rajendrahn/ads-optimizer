// Barrel for C1's daily normalization (§5, §12).

export { normalizeToReportingCurrency, normalizeAmountToReportingCurrency } from "./currency.ts";
export { mapNativeDayToReportingDay, type MappedReportingDay } from "./mapReportingDay.ts";
export {
  normalizeMetaInsightsDailyRow,
  type NormalizeMetaInsightsDailyRowCtx,
} from "./metaNormalize.ts";
export {
  normalizeShopifyOrder,
  normalizeShopifyRefund,
  type NormalizeShopifyRowCtx,
} from "./shopifyNormalize.ts";
export { computeShopifyDailyCoverage, type ComputeShopifyDailyCoverageInput } from "./coverage.ts";
export {
  normalizeMetaInsightsDailyHandler,
  normalizeMetaInsightsDailyRegistration,
  type NormalizeMetaInsightsDailyPayload,
} from "./normalizeMetaDailyTask.ts";
export {
  normalizeShopifyDailyHandler,
  normalizeShopifyDailyRegistration,
  type NormalizeShopifyDailyPayload,
} from "./normalizeShopifyDailyTask.ts";
