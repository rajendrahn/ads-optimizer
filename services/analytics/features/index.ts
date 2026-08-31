// Barrel for C2's feature engine (§4.2, §10.1, §12).

export {
  WINDOW_LENGTH_DAYS,
  ALL_WINDOW_LABELS,
  windowEnding,
  allWindowsEnding,
  previousEquivalentWindow,
  dayRangeLengthDays,
  daysInRange,
  type DayRange,
  type WindowLabel,
} from "./windows.ts";
export { markGap, unsafeIgnoreGap, combineGapVerdicts, type GapAware } from "./gapAware.ts";
export { aggregateShopifyWindow, type ShopifyWindowTotals } from "./shopifyWindowAggregate.ts";
export { aggregateMetaWindow, type MetaWindowTotals } from "./metaWindowAggregate.ts";
export {
  resolveSeasonalityContext,
  toSeasonalityContextSnapshot,
  NULL_SEASONALITY_CONTEXT,
  type SeasonalityContext,
  type SeasonalityContextProvider,
} from "./seasonality.ts";
export { buildEntityGraph, type EntityGraph, type EntityGraphInput } from "./entityGraph.ts";
export {
  ordersAttributedToEntity,
  refundsAttributedToEntity,
  buildOrderAttributionIndex,
  type FeatureEntityType,
  type OrderAttributionIndex,
} from "./attribution.ts";
export { buildWindowMetrics, type BuildWindowMetricsInput } from "./windowMetricsBuilder.ts";
export { computeTrend } from "./trend.ts";
export { buildEntityFeatures, type FeatureComputationContext } from "./entityFeaturesBuilder.ts";
export { readNextAccountDataVersion } from "./accountDataVersion.ts";
export {
  recomputeFeaturesHandler,
  recomputeFeaturesRegistration,
  type RecomputeFeaturesPayload,
} from "./recomputeFeaturesTask.ts";
