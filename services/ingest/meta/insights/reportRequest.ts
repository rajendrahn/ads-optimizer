// Pure request/response shaping for Meta's async Insights report job flow (§7.1):
//   1. POST /{ad_account_id}/insights  -> { report_run_id }
//   2. GET  /{report_run_id}?fields=async_status,async_percent_completion  (poll until terminal)
//   3. GET  /{report_run_id}/insights?limit=...&after=...  (page results once "Job Completed")
//
// No Firestore, no MetaClient — raw params in, raw Meta JSON in, typed values out. Kept
// deliberately free of any I/O so the request-shaping and status/row parsing logic is
// unit-testable without a fetch mock at all.

import type { ReportingDay } from "@shared/schema/index.ts";
import { parseAttributionWindowTokens } from "./attributionWindow.ts";

/** Always ad-level — §9.5's key is `metaInsightsDaily/{adId}_{date}`. */
export const INSIGHTS_LEVEL = "ad";

/** The fields requested on every page of results. `fetch.ts` (B2) documents the same "field
 * lists must stay a superset of what normalize.ts reads" convention this mirrors. */
export const INSIGHTS_FIELDS =
  "ad_id,adset_id,campaign_id,date_start,date_stop,spend,impressions,reach,frequency,clicks,actions,action_values";

export interface BuildSubmitParamsInput {
  since: ReportingDay;
  until: ReportingDay;
  /** The canon's pinned attribution window string (e.g. "7d_click_1d_view") — §5.3. */
  attributionWindow: string;
}

/** Builds the POST body for step 1. Throws (via `parseAttributionWindowTokens`) rather than
 * silently omitting `action_attribution_windows` — §5.3 requires the window to be pinned on
 * every request, not left to Meta's platform default. */
export function buildSubmitParams(input: BuildSubmitParamsInput): Record<string, string> {
  const tokens = parseAttributionWindowTokens(input.attributionWindow);
  return {
    level: INSIGHTS_LEVEL,
    time_increment: "1",
    time_range: JSON.stringify({ since: input.since, until: input.until }),
    fields: INSIGHTS_FIELDS,
    action_attribution_windows: JSON.stringify(tokens),
  };
}

export interface SubmitReportResponse {
  report_run_id?: string;
}

/** Extracts `report_run_id` from the submit response, throwing if Meta didn't return one (a
 * 200 with no id would otherwise silently produce a job this code can never poll again). */
export function extractReportRunId(response: SubmitReportResponse): string {
  if (!response.report_run_id) {
    throw new Error(
      `extractReportRunId: Meta's insights submission response had no report_run_id: ${JSON.stringify(response)}`,
    );
  }
  return response.report_run_id;
}

export interface ReportStatusResponse {
  async_status?: string;
  async_percent_completion?: number;
}

export type ReportStatusDecision = "ready" | "pending" | "failed";

/** Meta's documented `async_status` values for a report run. "Job Skipped" is grouped with
 * "Job Failed" — both mean this job will never produce results and must not be polled again. */
export function decideReportStatus(response: ReportStatusResponse): ReportStatusDecision {
  switch (response.async_status) {
    case "Job Completed":
      return "ready";
    case "Job Failed":
    case "Job Skipped":
      return "failed";
    case "Job Not Started":
    case "Job Started":
    case "Job Running":
      return "pending";
    default:
      // An unrecognized status string is treated as pending rather than failed — Meta's own
      // status vocabulary could grow, and failing a job outright on an unrecognized-but-benign
      // string would be worse than one extra poll attempt. pollAttempts still bounds this.
      return "pending";
  }
}

export function buildInsightsPageParams(after: string | null, limit = 500): Record<string, string> {
  const params: Record<string, string> = { limit: String(limit) };
  if (after) params.after = after;
  return params;
}

export interface RawInsightsAction {
  action_type?: string;
  value?: string;
}

export interface RawInsightsRow {
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  date_start?: string;
  date_stop?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  clicks?: string;
  actions?: RawInsightsAction[];
  action_values?: RawInsightsAction[];
}

export interface InsightsPageResponse {
  data?: RawInsightsRow[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** The value string for a given `action_type` in an actions/action_values array, or "0" when
 * absent — a genuine zero-conversion day for a given action type is normal and not an error. */
export function findActionValue(
  actions: RawInsightsAction[] | undefined,
  actionType: string,
): string {
  return actions?.find((a) => a.action_type === actionType)?.value ?? "0";
}
