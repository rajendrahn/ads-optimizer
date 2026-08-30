// META_SYNC_INSIGHTS (§10.2, §7.1) — decides the date window to fetch and submits it as a Meta
// async insights report job. This task's own run is DONE once the job is submitted; it never
// blocks waiting for Meta to produce results (§7.1: "A synchronous insights call over a long
// range... will fail" — and per this account's real scale, B2's live measurement of 1,139 ads,
// even the 14-day rolling reconciliation window is ~16K rows, so every window this task submits
// goes through the async job flow, not just the historical backfill). META_POLL_ASYNC_REPORT
// (pollAsyncReport.ts) is the task that actually advances the job to completion, across however
// many invocations that takes — see that file's own module comment for the state machine.
//
// `syncStateTarget: null` (see the registration at the bottom): this task never itself has new
// insight rows to report, so it owns no watermark — exactly the same reasoning B2 used for
// META_SNAPSHOT_CONFIG. META_POLL_ASYNC_REPORT owns `syncState/meta_insights`, since it is the
// only task that knows when a job's rows are actually fully written. This task still reads that
// watermark (for reconciliation windowing) via its own SyncStore instance — reading it doesn't
// require owning it.

import { getDb } from "@shared/firestore/index.ts";
import { syncStateKey } from "@shared/firestore/index.ts";
import { loadReportingCanon, toReportingDay, addCalendarDays } from "@shared/canon/index.ts";
import type { ReportingDay } from "@shared/schema/index.ts";
import { META_AD_ACCOUNT_ID } from "../../../../scripts/config.ts";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import { createFirestoreSyncStore } from "../../sync/store.ts";
import { computeReconciliationWindow } from "../../sync/reconciliationWindow.ts";
import {
  buildSubmitParams,
  extractReportRunId,
  type SubmitReportResponse,
} from "./reportRequest.ts";
import { createFirestoreReportJobStore } from "./reportJobStore.ts";

export type MetaSyncInsightsMode =
  "backfill" | "reconciliation_incremental" | "reconciliation_deep";

export interface MetaSyncInsightsPayload {
  mode?: MetaSyncInsightsMode;
  /** Backfill only. Defaults to `until - (backfillDays - 1)`. */
  since?: ReportingDay;
  /** Defaults to "today" in the reporting timezone for every mode. */
  until?: ReportingDay;
  /** §9.4's rolling window size, default 14. */
  reconciliationDays?: number;
  /** §9.4's weekly deep-pass size, default 60. */
  deepReconciliationDays?: number;
  /** Backfill only, used when `since` is omitted — default 365 (this step's own "a year of
   * history" done-when bar). A longer true backfill can be requested by passing `since`
   * explicitly. */
  backfillDays?: number;
}

function parsePayload(raw: unknown): MetaSyncInsightsPayload {
  if (typeof raw !== "object" || raw === null) return {};
  return raw as MetaSyncInsightsPayload;
}

export const metaSyncInsightsHandler: TaskHandler = async (ctx) => {
  const payload = parsePayload(ctx.payload);
  const mode: MetaSyncInsightsMode = payload.mode ?? "reconciliation_incremental";
  const canon = await loadReportingCanon();
  const today = toReportingDay(new Date(), canon.reportingTimezone);
  const until = payload.until ?? today;

  let since: ReportingDay;
  if (mode === "backfill") {
    const backfillDays = payload.backfillDays ?? 365;
    since = payload.since ?? addCalendarDays(until, -(backfillDays - 1));
  } else {
    const db = getDb();
    const syncStore = createFirestoreSyncStore(db);
    const state = await syncStore.getSyncState(syncStateKey("meta", "insights"));
    const watermark = state?.lastDataDate ?? null;
    const window = computeReconciliationWindow({
      watermark,
      today: until,
      reconciliationDays: payload.reconciliationDays ?? 14,
      mode: mode === "reconciliation_deep" ? "deep" : "incremental",
      deepReconciliationDays: payload.deepReconciliationDays ?? 60,
    });
    since = window.startDate;
  }

  const meta = await ctx.getMetaClient();
  const submitParams = buildSubmitParams({
    since,
    until,
    attributionWindow: canon.attributionWindow,
  });

  const { data } = await meta.post<SubmitReportResponse>(
    `/${META_AD_ACCOUNT_ID}/insights`,
    submitParams,
  );

  await ctx.archiver.archive({
    source: "meta",
    day: today,
    resource: "insights_submit",
    runId: ctx.runId,
    payload: { request: submitParams, response: data },
  });

  const reportRunId = extractReportRunId(data);
  const now = new Date();

  const jobStore = createFirestoreReportJobStore(getDb());
  await jobStore.set(reportRunId, {
    reportRunId,
    reason: mode,
    since,
    until,
    attribution: {
      attributionWindow: canon.attributionWindow,
      purchaseActionType: canon.purchaseActionType,
    },
    phase: "SUBMITTED",
    pageCursor: null,
    rowsWritten: 0,
    pollAttempts: 0,
    submittedByRunId: ctx.runId,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });

  return {
    summary: { reportRunId, since, until, reason: mode },
  };
};

export const metaSyncInsightsRegistration: TaskRegistration = {
  taskType: "META_SYNC_INSIGHTS",
  runSource: "meta",
  // No watermark of its own — see module comment. META_POLL_ASYNC_REPORT owns it.
  syncStateTarget: null,
  handler: metaSyncInsightsHandler,
};
