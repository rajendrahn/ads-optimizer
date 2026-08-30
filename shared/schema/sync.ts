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
