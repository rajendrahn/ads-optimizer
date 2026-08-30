// Sync collections — §8: syncState, syncRuns, backtestRuns.
//
// Lifecycle (start/succeed/fail/watermark) is B1's job (§9.3, §9.4, §10.2); A2 only fixes
// the document shape.

import { z } from "zod";
import { firestoreTimestamp, reportingDay } from "./common.ts";

// ---------------------------------------------------------------------------------------
// syncState/{source}_{resource} — §9.3's example shape, taken almost verbatim.
// ---------------------------------------------------------------------------------------

export const syncStatusSchema = z.enum(["healthy", "no_new_data", "unauthorized"]); // §9.6
export type SyncStatus = z.infer<typeof syncStatusSchema>;

/**
 * A known hole in coverage, recorded explicitly rather than left for a later step to discover
 * the hard way — B5's motivating case: Shopify's Matrixify backfill and its `read_orders`-
 * scoped ongoing sync (60-day window) do not currently overlap, so there is a real span of
 * calendar time with no order data at all and no sync task that will ever fill it on its own.
 * `[startDate, endDateExclusive)` — both reporting days (§5.1). Any later step windowing over
 * data (C1/C2's N-day aggregates in particular) must treat a day inside a recorded gap as
 * "genuinely no data", not "zero activity".
 */
export const syncStateKnownGapSchema = z.object({
  startDate: reportingDay,
  endDateExclusive: reportingDay,
  reason: z.string().min(1),
});
export type SyncStateKnownGap = z.infer<typeof syncStateKnownGapSchema>;

export const syncStateSchema = z.object({
  source: z.enum(["meta", "shopify"]),
  resource: z.string().min(1), // e.g. "insights", "entities", "orders"
  accountId: z.string().min(1),
  lastSuccessfulSyncAt: firestoreTimestamp.nullable(),
  lastDataDate: reportingDay.nullable(),
  reconciliationDays: z.number().int().nonnegative().nullable(),
  attributionWindow: z.string().nullable(),
  status: syncStatusSchema,
  lastRunId: z.string().nullable(),
  // Both added by B5, optional/defaulted per A2's schema-evolution rule.
  //
  // `backfillCoverageThroughDate`: the furthest reporting day a one-time historical seed (e.g.
  // B5's Matrixify import) actually reached, as measured from the data itself — not a value
  // any later step should hardcode, since a fresh export can push it forward. Left untouched
  // (carried forward) by any task run that doesn't explicitly recompute it — see
  // services/ingest/sync/taskWrapper.ts's `TaskHandlerResult.backfillCoverageThroughDate`.
  //
  // `knownGaps`: recomputed fresh on every run of a task that knows how to detect one for its
  // resource (§9.6-style "state that must be recorded, not just implied") — not accumulated,
  // so a later export that closes a gap makes it disappear on the next run rather than
  // lingering as a stale entry.
  // `.optional()` (not `.default()`) deliberately: several other steps (B1, B3, ...) already
  // construct `SyncState` object literals directly (not through `.parse()`), and this keeps
  // those source-compatible — omitting the key is valid input AND a valid parsed value here,
  // vs. `.default()` which would make the *output* type require the key. taskWrapper.ts's own
  // carry-forward logic normalizes an omitted value to `null` where it matters.
  backfillCoverageThroughDate: reportingDay.nullable().optional(),
  knownGaps: z.array(syncStateKnownGapSchema).nullable().optional(),
});
export type SyncState = z.infer<typeof syncStateSchema>;

// ---------------------------------------------------------------------------------------
// syncRuns/{runId} — §10.2: "records start/end/error status, updates its watermark only
// after successful completion." `versionGuardRejections` is a starting shape for §9.5's
// "log the rejection in syncRuns so ordering problems stay observable" — B1 decides whether
// rejections accumulate as an array here or in a subcollection at real volume.
// ---------------------------------------------------------------------------------------

export const syncRunStatusSchema = z.enum(["RUNNING", "SUCCEEDED", "FAILED"]);
export type SyncRunStatus = z.infer<typeof syncRunStatusSchema>;

export const versionGuardRejectionLogEntrySchema = z.object({
  collection: z.string().min(1),
  docId: z.string().min(1),
  reason: z.string(),
  incomingUpdatedAt: firestoreTimestamp,
  currentUpdatedAt: firestoreTimestamp,
  loggedAt: firestoreTimestamp,
});
export type VersionGuardRejectionLogEntry = z.infer<typeof versionGuardRejectionLogEntrySchema>;

export const syncRunSchema = z.object({
  runId: z.string().min(1),
  // Kept as a free string rather than an enum of §10.2's task-type list, so B1 can extend
  // the task registry without a schema change here.
  taskType: z.string().min(1),
  source: z.enum(["meta", "shopify", "internal"]).nullable(),
  status: syncRunStatusSchema,
  startedAt: firestoreTimestamp,
  finishedAt: firestoreTimestamp.nullable(),
  error: z.string().nullable(),
  watermarkBefore: z.string().nullable(),
  watermarkAfter: z.string().nullable(),
  versionGuardRejections: z.array(versionGuardRejectionLogEntrySchema).nullable(),
});
export type SyncRun = z.infer<typeof syncRunSchema>;

// ---------------------------------------------------------------------------------------
// backtestRuns/{id} — §21.2
// ---------------------------------------------------------------------------------------

export const backtestRunSchema = z.object({
  backtestRunId: z.string().min(1),
  asOfDate: reportingDay,
  // §21.2/§29 criterion 10: the system's strategy must beat this naive baseline.
  strategy: z.enum(["SYSTEM", "NAIVE_HIGHEST_RECENT_ROAS"]),
  decisionUnit: z.object({ type: z.string(), id: z.string() }).nullable(),
  generatedRecommendation: z.unknown().nullable(),
  actualOutcome: z.unknown().nullable(),
  brierScoreComponent: z.number().nullable(),
  createdAt: firestoreTimestamp,
});
export type BacktestRun = z.infer<typeof backtestRunSchema>;
