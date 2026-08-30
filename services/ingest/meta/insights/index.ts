// Barrel for B3's Meta insights sync (§10.2: META_SYNC_INSIGHTS, META_POLL_ASYNC_REPORT).

export { parseAttributionWindowTokens } from "./attributionWindow.ts";
export { mapWithConcurrency } from "./concurrency.ts";
export {
  buildInsightsPageParams,
  buildSubmitParams,
  decideReportStatus,
  extractReportRunId,
  findActionValue,
  INSIGHTS_FIELDS,
  INSIGHTS_LEVEL,
  type BuildSubmitParamsInput,
  type InsightsPageResponse,
  type RawInsightsAction,
  type RawInsightsRow,
  type ReportStatusDecision,
  type ReportStatusResponse,
  type SubmitReportResponse,
} from "./reportRequest.ts";
export { normalizeInsightsRow, type NormalizeInsightsRowCtx } from "./normalize.ts";
export {
  createFirestoreReportJobStore,
  createInMemoryReportJobStore,
  type ReportJobStore,
} from "./reportJobStore.ts";
export {
  metaSyncInsightsHandler,
  metaSyncInsightsRegistration,
  type MetaSyncInsightsMode,
  type MetaSyncInsightsPayload,
} from "./insightsSync.ts";
export {
  metaPollAsyncReportHandler,
  metaPollAsyncReportRegistration,
  type MetaPollAsyncReportPayload,
} from "./pollAsyncReport.ts";
