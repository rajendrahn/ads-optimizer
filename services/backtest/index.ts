// Barrel for E1's backtest harness (§21.2, §23, IMPLEMENTATION_PLAN.md E1).

export {
  PointInTimeArchiveReader,
  wrapGcsBucketAsListable,
  type ArchiveListable,
  type ArchivedPayloadRecord,
  type SyncRunKnowledge,
  type SyncRunSource,
} from "./pointInTimeArchive.ts";
export { parseRawArchivePath, type ParsedArchivePath } from "./archivePath.ts";
export { createFirestoreSyncRunSource } from "./syncRunSource.ts";
export {
  reconstructMetaInsightsNormalizedAsOf,
  type ReconstructMetaInsightsCtx,
} from "./reconstructMeta.ts";
export {
  reconstructShopifyNormalizedAsOf,
  type ReconstructShopifyCtx,
  type ReconstructedShopifyState,
} from "./reconstructShopify.ts";
export {
  buildAdSetWindowEvidence,
  computeAccountMetaMeans,
  groupMetaRowsByAdset,
  type AdSetWindowEvidence,
} from "./evidence.ts";
export {
  decideNaiveHighestRecentRoas,
  decideSystemStrategy,
  type BacktestActionType,
  type BacktestRecommendation,
} from "./strategies.ts";
export { computeActualOutcome, computeBrierScoreComponent, type ActualOutcome } from "./outcome.ts";
export {
  runBacktestForDate,
  type RunBacktestInput,
  type RunBacktestResult,
} from "./runBacktest.ts";
