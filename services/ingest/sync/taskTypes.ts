// §10.2's Cloud Tasks task-type registry surface.
//
// `syncRunSchema.taskType` (shared/schema/sync.ts, A2) is deliberately a free `z.string()`,
// not an enum, "so B1 can extend the task registry without a schema change" — the list below
// is therefore documentation of what §10.2 names, not something anything else validates
// against at runtime. `TaskRegistry` (registry.ts) is the actual source of truth: a task type
// is "real" exactly when something has called `.register()` for it.
//
// B1 registers none of these — B2 through B8 do, one or more each, as they land. B1 only
// registers `SYNC_NOOP` (below), the framework's own no-op/health-check task, which is not
// one of §10.2's business task types and is never expected to move a watermark.

/** §10.2, verbatim, plus one B5 addition below. Not yet all registered — see each step's own
 * file under services/ingest. */
export const SYNC_TASK_TYPES = [
  "META_SYNC_ENTITIES",
  "META_SYNC_INSIGHTS",
  "META_POLL_ASYNC_REPORT",
  "META_SNAPSHOT_CONFIG",
  "SHOPIFY_SYNC_ORDERS",
  "SHOPIFY_RECONCILE_ORDERS",
  "AUDIT_AD_URL_TAGS",
  "PROCESS_CREATIVE",
  "RECOMPUTE_FEATURES",
  "GENERATE_RECOMMENDATION",
  "EVALUATE_RECOMMENDATION_OUTCOME",
  // B5's addition — not in §10.2's original list. The Matrixify CSV backfill is a genuinely
  // different operation from SHOPIFY_SYNC_ORDERS (reads a GCS object, not the Shopify API; row-
  // grouping parse, not GraphQL pagination) and needed its own retryable task type rather than
  // being folded into SHOPIFY_SYNC_ORDERS's handler. It is also, per IMPLEMENTATION_PLAN.md B5's
  // orchestrator brief, deliberately re-runnable against successive export files — not the
  // one-time-only operation §10.2/B5's original "Out of scope" line assumed before the real
  // export turned out to be a partial (~10k of ~22.6k orders) snapshot.
  "SHOPIFY_IMPORT_ORDERS_CSV",
] as const;
export type KnownTaskType = (typeof SYNC_TASK_TYPES)[number];

/** B1's own framework-level task — proves the wrapper end-to-end without touching any real
 * external API. Registered by `createDefaultRegistry()` in registry.ts. Also useful in
 * production as an ops health check ("is the dispatch path alive") independent of any sync. */
export const SYNC_NOOP = "SYNC_NOOP";
