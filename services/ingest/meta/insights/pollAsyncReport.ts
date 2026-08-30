// META_POLL_ASYNC_REPORT (§10.2, §7.1) — advances ONE metaInsightsReportJobs/{reportRunId}
// through its state machine by exactly one bounded step per invocation:
//
//   SUBMITTED/POLLING --(poll async_status)--> still pending: throw (retryable) -> redelivered
//                                            \-> "Job Completed": transition to PAGING, fall
//                                                through to paging in this same invocation
//                                            \-> "Job Failed"/"Job Skipped": phase=FAILED, throw
//                                                (terminal, non-retryable)
//   PAGING            --(page up to N pages, upsert each row)--> more pages remain: save cursor,
//                                            throw (retryable) -> redelivered, resumes from cursor
//                                            \-> no more pages: phase=DONE, return success
//                                                (this is the ONLY branch that reports
//                                                newWatermarkDate, so syncState/meta_insights
//                                                only advances once a job is truly fully written)
//   DONE              --> idempotent no-op success (a redelivered/duplicate poll after
//                          completion does nothing)
//   FAILED            --> throw (terminal) — a job that failed once never resumes
//
// This IS the "own state machine inside the task framework, not a loop" the step spec asks for:
// no `while(true) { sleep(); poll(); }` inside a handler tying up compute for however long a
// Meta report job takes (minutes to tens of minutes). Progress instead comes from the task
// framework's OWN retry model — a thrown retryable error becomes an HTTP 500 (httpHandler.ts),
// which Cloud Tasks redelivers the SAME task id later per the queue's own backoff config, and
// runSyncTask's idempotency-by-taskId means that redelivery overwrites the SAME `syncRuns` doc
// rather than accumulating one per poll attempt. All actual progress state (phase, cursor, rows
// written so far) lives in the `metaInsightsReportJobs` doc, not in the task's own memory, which
// is what lets a poll resume correctly regardless of which invocation (or, in principle, which
// Cloud Run instance) picks up the redelivered task.
//
// Bounded, resumable paging (`maxPagesPerInvocation`) is deliberate, not incidental — B2 measured
// this account at 1,139 ads live; a single reconciliation window (14 days) is ~16K rows, and a
// year's backfill is ~415K. Processing all of that in one invocation would risk an unbounded,
// unrecoverable-on-failure request; capping pages per invocation and persisting the cursor makes
// every chunk of work retryable on its own.

import { getDb } from "@shared/firestore/index.ts";
import {
  COLLECTIONS,
  metaInsightsDailyKey,
  upsertWithVersionGuard,
} from "@shared/firestore/index.ts";
import {
  metaInsightsDailySchema,
  type MetaInsightsReportJob,
  type ReportingDay,
} from "@shared/schema/index.ts";
import { META_AD_ACCOUNT_ID } from "../../../../scripts/config.ts";
import { ApiError } from "../../http/errors.ts";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import { fetchAccountCurrency } from "../entities/fetch.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { normalizeInsightsRow } from "./normalize.ts";
import {
  buildInsightsPageParams,
  decideReportStatus,
  type InsightsPageResponse,
  type ReportStatusResponse,
} from "./reportRequest.ts";
import { createFirestoreReportJobStore, type ReportJobStore } from "./reportJobStore.ts";

export interface MetaPollAsyncReportPayload {
  reportRunId?: string;
  /** Poll attempts (each one a full task-framework retry cycle) before giving up on a job that
   * never leaves POLLING — default 90. At Cloud Tasks' own backoff, this is a generous multi-hour
   * ceiling; a real Meta async report normally completes in minutes. */
  maxPollAttempts?: number;
  /** Pages of results processed per invocation before saving the cursor and yielding back to the
   * task framework — default 5 (with `pageLimit` 500, ~2,500 rows/invocation). */
  maxPagesPerInvocation?: number;
  pageLimit?: number;
  /** Concurrent `upsertWithVersionGuard` transactions in flight at once — default 20. */
  writeConcurrency?: number;
}

function parsePayload(raw: unknown): MetaPollAsyncReportPayload {
  if (typeof raw !== "object" || raw === null) return {};
  return raw as MetaPollAsyncReportPayload;
}

function terminal(message: string): ApiError {
  return new ApiError(message, { kind: "client_error", retryable: false });
}

async function pageResults(
  ctx: Parameters<TaskHandler>[0],
  job: MetaInsightsReportJob,
  jobStore: ReportJobStore,
  opts: Required<
    Pick<MetaPollAsyncReportPayload, "maxPagesPerInvocation" | "pageLimit" | "writeConcurrency">
  >,
): Promise<{
  newRowCount: number;
  newWatermarkDate?: ReportingDay;
  summary: Record<string, unknown>;
}> {
  const meta = await ctx.getMetaClient();
  const db = getDb();
  const currency = await fetchAccountCurrency(meta);
  const fetchedAt = new Date();

  let cursor = job.pageCursor;
  let rowsThisInvocation = 0;
  let donePaging = false;

  for (let page = 0; page < opts.maxPagesPerInvocation; page++) {
    const params = buildInsightsPageParams(cursor, opts.pageLimit);
    const { data: pageData } = await meta.get<InsightsPageResponse>(
      `/${job.reportRunId}/insights`,
      params,
    );

    await ctx.archiver.archive({
      source: "meta",
      day: job.until, // this job's natural anchor day — see module comment
      resource: "insights_page",
      runId: ctx.runId,
      payload: pageData,
    });

    const rawRows = pageData.data ?? [];
    const normalized = rawRows.map((row) =>
      normalizeInsightsRow(row, {
        accountId: META_AD_ACCOUNT_ID,
        currency,
        attribution: job.attribution,
        fetchedAt,
      }),
    );

    await mapWithConcurrency(normalized, opts.writeConcurrency, (doc) =>
      upsertWithVersionGuard({
        db,
        collectionName: COLLECTIONS.metaInsightsDaily,
        docId: metaInsightsDailyKey(doc.adId, doc.date),
        incoming: doc,
        schema: metaInsightsDailySchema,
        onRejected: ctx.recordVersionGuardRejection,
      }),
    );

    rowsThisInvocation += normalized.length;

    const nextAfter = pageData.paging?.cursors?.after ?? null;
    const hasNext = Boolean(pageData.paging?.next) && Boolean(nextAfter);
    cursor = hasNext ? nextAfter : null;
    if (!hasNext) {
      donePaging = true;
      break;
    }
  }

  const rowsWritten = job.rowsWritten + rowsThisInvocation;
  const updatedAt = new Date();

  if (donePaging) {
    await jobStore.set(job.reportRunId, {
      ...job,
      phase: "DONE",
      pageCursor: null,
      rowsWritten,
      updatedAt,
    });
    return {
      newRowCount: rowsThisInvocation,
      // The ONLY branch that reports a watermark — see module comment: syncState/meta_insights
      // only advances once a job is fully paged, never on a partial/in-progress invocation.
      newWatermarkDate: job.until,
      summary: {
        reportRunId: job.reportRunId,
        phase: "DONE",
        rowsWrittenThisInvocation: rowsThisInvocation,
        rowsWrittenTotal: rowsWritten,
      },
    };
  }

  await jobStore.set(job.reportRunId, {
    ...job,
    phase: "PAGING",
    pageCursor: cursor,
    rowsWritten,
    updatedAt,
  });
  // Retryable (plain Error, not a terminal ApiError) — more pages remain; the task framework
  // should redeliver this same task so the next invocation resumes from the saved cursor.
  throw new Error(
    `META_POLL_ASYNC_REPORT: report job ${job.reportRunId} has more pages remaining ` +
      `(wrote ${rowsThisInvocation} rows this invocation, ${rowsWritten} total so far) — will resume on retry`,
  );
}

export const metaPollAsyncReportHandler: TaskHandler = async (ctx) => {
  const payload = parsePayload(ctx.payload);
  if (!payload.reportRunId) {
    throw terminal("META_POLL_ASYNC_REPORT: payload.reportRunId is required");
  }

  const maxPollAttempts = payload.maxPollAttempts ?? 90;
  const maxPagesPerInvocation = payload.maxPagesPerInvocation ?? 5;
  const pageLimit = payload.pageLimit ?? 500;
  const writeConcurrency = payload.writeConcurrency ?? 20;

  const jobStore = createFirestoreReportJobStore(getDb());
  const job = await jobStore.get(payload.reportRunId);
  if (!job) {
    throw terminal(
      `META_POLL_ASYNC_REPORT: no metaInsightsReportJobs/${payload.reportRunId} found`,
    );
  }

  if (job.phase === "DONE") {
    return {
      newRowCount: 0,
      summary: { reportRunId: job.reportRunId, phase: "DONE", note: "already done" },
    };
  }
  if (job.phase === "FAILED") {
    throw terminal(
      `META_POLL_ASYNC_REPORT: report job ${job.reportRunId} already failed terminally: ${job.lastError}`,
    );
  }

  if (job.phase === "SUBMITTED" || job.phase === "POLLING") {
    const meta = await ctx.getMetaClient();
    const { data: status } = await meta.get<ReportStatusResponse>(`/${job.reportRunId}`, {
      fields: "async_status,async_percent_completion",
    });
    const decision = decideReportStatus(status);
    const updatedAt = new Date();

    if (decision === "failed") {
      await jobStore.set(job.reportRunId, {
        ...job,
        phase: "FAILED",
        lastError: `Meta reported async_status="${status.async_status}"`,
        updatedAt,
      });
      throw terminal(
        `META_POLL_ASYNC_REPORT: Meta reported report job ${job.reportRunId} as "${status.async_status}"`,
      );
    }

    if (decision === "pending") {
      const pollAttempts = job.pollAttempts + 1;
      if (pollAttempts >= maxPollAttempts) {
        await jobStore.set(job.reportRunId, {
          ...job,
          phase: "FAILED",
          pollAttempts,
          lastError: `exceeded maxPollAttempts (${maxPollAttempts}) while still "${status.async_status}"`,
          updatedAt,
        });
        throw terminal(
          `META_POLL_ASYNC_REPORT: report job ${job.reportRunId} exceeded ${maxPollAttempts} poll attempts`,
        );
      }
      await jobStore.set(job.reportRunId, { ...job, phase: "POLLING", pollAttempts, updatedAt });
      throw new Error(
        `META_POLL_ASYNC_REPORT: report job ${job.reportRunId} not ready yet ` +
          `(async_status="${status.async_status}", attempt ${pollAttempts}/${maxPollAttempts}) — will retry`,
      );
    }

    // decision === "ready": transition to PAGING and fall through into paging in this same
    // invocation, rather than requiring one more redelivery just to notice the job is done.
    const readyJob: MetaInsightsReportJob = { ...job, phase: "PAGING", updatedAt };
    await jobStore.set(job.reportRunId, readyJob);
    return pageResults(ctx, readyJob, jobStore, {
      maxPagesPerInvocation,
      pageLimit,
      writeConcurrency,
    });
  }

  // job.phase === "PAGING" already (resuming from a saved cursor).
  return pageResults(ctx, job, jobStore, { maxPagesPerInvocation, pageLimit, writeConcurrency });
};

export const metaPollAsyncReportRegistration: TaskRegistration = {
  taskType: "META_POLL_ASYNC_REPORT",
  runSource: "meta",
  // The ONLY task that knows when insight rows are actually fully written — see module comment.
  syncStateTarget: { source: "meta", resource: "insights" },
  handler: metaPollAsyncReportHandler,
};
