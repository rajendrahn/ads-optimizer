// The uniform task wrapper — §10.2: "Each task is idempotent, has retry behaviour, respects
// API limits, records start/end/error status, and updates its watermark only after successful
// completion."
//
// `runSyncTask` is the one function every task type's execution goes through, whether invoked
// directly (tests, a one-off script) or via httpHandler.ts (the Cloud Tasks HTTP target). It
// owns:
//
//   - Idempotency: the caller supplies (or this generates) a `taskId`, which becomes the
//     `syncRuns` document id. A `taskId` whose `syncRuns` doc is already `SUCCEEDED` short-
//     circuits — the handler never runs again, and `syncState` is never touched again — so a
//     duplicate delivery (Cloud Tasks' at-least-once contract, or an operator re-enqueueing by
//     hand) is a no-op. A `taskId` that's `RUNNING`/`FAILED`, or has no doc yet, re-attempts.
//   - Retry semantics: a thrown error is classified retryable/terminal (reusing `ApiError.kind`
//     where the handler threw one; anything else defaults retryable, matching
//     `services/ingest/http/retry.ts`'s convention). `shouldRetry` on the result is what
//     httpHandler.ts turns into a 5xx (retry) vs 2xx (stop — see that file's own comment for
//     why a terminal failure still gets a 2xx).
//   - Structured error recording: every attempt writes a `syncRuns` doc — RUNNING at the start,
//     then SUCCEEDED or FAILED with `error` set to the classified message.
//   - Watermark advance only on success: `syncState` is read once (for `watermarkBefore`) and
//     written at most once, only in the success branch, only for a task type that declares a
//     `syncStateTarget` (registry.ts). A failed run leaves `syncState` completely untouched.
//   - The orchestrator note under A4: Meta/Shopify clients are constructed **at most once per
//     task run**, lazily, memoized — never per request within the handler. `ctx.getMetaClient()`
//     /`ctx.getShopifyClient()` are the only way a handler should obtain one; calling either
//     more than once returns the same in-flight/resolved client.
//   - The A2 orchestrator note: `upsertWithVersionGuard`'s `onRejected` hook has a home. Pass
//     `ctx.recordVersionGuardRejection` as `onRejected` and every rejection during this run
//     lands in `syncRuns.versionGuardRejections` (A2's `versionGuardRejectionLogEntrySchema`),
//     regardless of whether the run overall succeeds or fails.

import type { VersionGuardRejection } from "@shared/firestore/index.ts";
import type {
  ReportingDay,
  SyncRun,
  SyncState,
  VersionGuardRejectionLogEntry,
} from "@shared/schema/index.ts";
import { syncStateKey } from "@shared/firestore/index.ts";
import { randomUUID } from "node:crypto";
import { META_AD_ACCOUNT_ID } from "../../../scripts/config.ts";
import { ApiError } from "../http/errors.ts";
import { classifySyncStatus } from "../health.ts";
import { MetaClient, createMetaClient } from "../meta/client.ts";
import { ShopifyClient, createShopifyClient } from "../shopify/client.ts";
import type { RawArchiveStore } from "./archiver.ts";
import type { TaskRegistry } from "./registry.ts";
import type { SyncStore } from "./store.ts";

export interface TaskHandlerResult {
  /** The furthest reporting day this run's data now covers, if this task type has a
   * watermark. Omit (or return the same value the run started with) if the run fetched no new
   * data. Ignored for task types with `syncStateTarget: null`. */
  newWatermarkDate?: ReportingDay;
  /** Rows fetched/upserted this run, if the task type has a meaningful notion of "rows" —
   * drives `classifySyncStatus`'s `healthy` vs `no_new_data` distinction (§9.6). Omit when not
   * applicable; that defaults to `healthy` (see services/ingest/health.ts). */
  newRowCount?: number;
  /** Free-form, for logs/debugging — not currently persisted onto `syncRuns` (that schema has
   * no field for it yet); surfaced on `RunSyncTaskResult` for a caller/test to inspect. */
  summary?: Record<string, unknown>;
  /** B5's addition to `syncState` (shared/schema/sync.ts) — see that file's field comments.
   * Both follow the same carry-forward-if-omitted rule as everything else `syncState` keeps
   * across runs (`reconciliationDays`, `attributionWindow` below): a handler that doesn't know
   * how to compute one of these for its resource should simply not set it, leaving whatever
   * the previous run stored untouched. Passing `null` explicitly clears it (distinct from
   * `undefined`, which leaves it alone) — needed so a handler can actually close a gap once
   * its data closes it, not just widen or ignore one. Ignored for task types with
   * `syncStateTarget: null`. */
  backfillCoverageThroughDate?: ReportingDay | null;
  knownGaps?: SyncState["knownGaps"];
}

export interface TaskContext {
  runId: string;
  taskType: string;
  payload: unknown;
  archiver: RawArchiveStore;
  /** Memoized per task run — see module comment. Throws whatever `createMetaClientImpl` throws
   * (e.g. a Secret Manager failure) on first call; subsequent calls replay that rejection
   * rather than retrying the construction, matching a normal memoized-promise contract. */
  getMetaClient(): Promise<MetaClient>;
  getShopifyClient(): Promise<ShopifyClient>;
  /** Pass this as `upsertWithVersionGuard`'s `onRejected` — see module comment. */
  recordVersionGuardRejection(rejection: VersionGuardRejection): void;
}

export type TaskHandler = (ctx: TaskContext) => Promise<TaskHandlerResult>;

export interface RunSyncTaskOptions {
  syncStore: SyncStore;
  registry: TaskRegistry;
  taskType: string;
  payload: unknown;
  archiver: RawArchiveStore;
  /** Idempotency key — becomes the `syncRuns` document id. Defaults to a random UUID (a fresh,
   * never-retried run). A caller that wants retries of the *same* logical task to collapse
   * onto one `syncRuns` doc (e.g. httpHandler.ts, threading through Cloud Tasks' own task id)
   * must supply this explicitly. */
  taskId?: string;
  /** The account these `syncState` watermarks belong to. Defaults to the account this whole
   * system is scoped to (§8: "one brand, one ad account"). */
  accountId?: string;
  now?: () => Date;
  /** Overridable for tests — defaults to A4's real `createMetaClient`/`createShopifyClient`
   * (Secret Manager + live credentials). */
  createMetaClientImpl?: () => Promise<MetaClient>;
  createShopifyClientImpl?: () => Promise<ShopifyClient>;
}

export type RunSyncTaskStatus = "SUCCEEDED" | "FAILED" | "SKIPPED_ALREADY_SUCCEEDED";

export interface RunSyncTaskResult {
  runId: string;
  status: RunSyncTaskStatus;
  /** Whether the caller (httpHandler.ts) should signal Cloud Tasks to retry. Always `false`
   * for SUCCEEDED/SKIPPED_ALREADY_SUCCEEDED. */
  shouldRetry: boolean;
  error?: string;
  summary?: Record<string, unknown>;
}

/** Memoizes a zero-arg async factory so it runs at most once; every caller after the first
 * awaits the same in-flight/settled promise. A rejection is cached too (not retried on the
 * next call within this run) — a task run that fails to construct a client should fail once,
 * not hammer Secret Manager/the platform once per handler call site. */
function memoizeAsync<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (!cached) cached = factory();
    return cached;
  };
}

function classifyTaskError(err: unknown): { retryable: boolean; message: string } {
  if (err instanceof ApiError) return { retryable: err.retryable, message: err.message };
  if (err instanceof Error) return { retryable: true, message: err.message };
  return { retryable: true, message: String(err) };
}

export async function runSyncTask(opts: RunSyncTaskOptions): Promise<RunSyncTaskResult> {
  const now = opts.now ?? (() => new Date());
  const runId = opts.taskId ?? randomUUID();
  const accountId = opts.accountId ?? META_AD_ACCOUNT_ID;

  // Idempotency: a run already recorded as SUCCEEDED never re-executes and never re-touches
  // syncState — see module comment.
  const existing = await opts.syncStore.getSyncRun(runId);
  if (existing && existing.status === "SUCCEEDED") {
    return { runId, status: "SKIPPED_ALREADY_SUCCEEDED", shouldRetry: false };
  }

  const registration = opts.registry.get(opts.taskType);
  const startedAt = now();

  if (!registration) {
    const message = `runSyncTask: no handler registered for task type "${opts.taskType}"`;
    await opts.syncStore.setSyncRun(runId, {
      runId,
      taskType: opts.taskType,
      source: null,
      status: "FAILED",
      startedAt,
      finishedAt: startedAt,
      error: message,
      watermarkBefore: null,
      watermarkAfter: null,
      versionGuardRejections: null,
    });
    // Unknown task type: retrying will never resolve it. Terminal.
    return { runId, status: "FAILED", shouldRetry: false, error: message };
  }

  const stateKey = registration.syncStateTarget
    ? syncStateKey(registration.syncStateTarget.source, registration.syncStateTarget.resource)
    : null;
  const priorState = stateKey ? await opts.syncStore.getSyncState(stateKey) : null;
  const watermarkBefore = priorState?.lastDataDate ?? null;

  const initialRun: SyncRun = {
    runId,
    taskType: opts.taskType,
    source: registration.runSource,
    status: "RUNNING",
    startedAt,
    finishedAt: null,
    error: null,
    watermarkBefore,
    watermarkAfter: null,
    versionGuardRejections: null,
  };
  await opts.syncStore.setSyncRun(runId, initialRun);

  const rejections: VersionGuardRejectionLogEntry[] = [];
  const ctx: TaskContext = {
    runId,
    taskType: opts.taskType,
    payload: opts.payload,
    archiver: opts.archiver,
    getMetaClient: memoizeAsync(opts.createMetaClientImpl ?? (() => createMetaClient())),
    getShopifyClient: memoizeAsync(opts.createShopifyClientImpl ?? (() => createShopifyClient())),
    recordVersionGuardRejection(rejection) {
      rejections.push({ ...rejection, loggedAt: now() });
    },
  };

  try {
    const result = await registration.handler(ctx);
    const finishedAt = now();
    const watermarkAfter = registration.syncStateTarget
      ? (result.newWatermarkDate ?? watermarkBefore)
      : null;

    await opts.syncStore.setSyncRun(runId, {
      ...initialRun,
      status: "SUCCEEDED",
      finishedAt,
      watermarkAfter,
      versionGuardRejections: rejections.length > 0 ? rejections : null,
    });

    if (registration.syncStateTarget && stateKey) {
      await opts.syncStore.setSyncState(stateKey, {
        source: registration.syncStateTarget.source,
        resource: registration.syncStateTarget.resource,
        accountId: priorState?.accountId ?? accountId,
        lastSuccessfulSyncAt: finishedAt,
        lastDataDate: watermarkAfter,
        reconciliationDays: priorState?.reconciliationDays ?? null,
        attributionWindow: priorState?.attributionWindow ?? null,
        status: classifySyncStatus({ authorized: true, newRowCount: result.newRowCount }),
        lastRunId: runId,
        // B5's carry-forward-unless-set fields — see TaskHandlerResult's comment.
        backfillCoverageThroughDate:
          result.backfillCoverageThroughDate !== undefined
            ? result.backfillCoverageThroughDate
            : (priorState?.backfillCoverageThroughDate ?? null),
        knownGaps:
          result.knownGaps !== undefined ? result.knownGaps : (priorState?.knownGaps ?? null),
      });
    }

    return { runId, status: "SUCCEEDED", shouldRetry: false, summary: result.summary };
  } catch (err) {
    const { retryable, message } = classifyTaskError(err);
    const finishedAt = now();

    await opts.syncStore.setSyncRun(runId, {
      ...initialRun,
      status: "FAILED",
      finishedAt,
      error: message,
      watermarkAfter: null,
      versionGuardRejections: rejections.length > 0 ? rejections : null,
    });

    // syncState is deliberately untouched here — §10.2: watermark advances only on success.
    return { runId, status: "FAILED", shouldRetry: retryable, error: message };
  }
}
