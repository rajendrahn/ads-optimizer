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

/** §10.2, verbatim. Not yet all registered — see each step's own file under services/ingest. */
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
] as const;
export type KnownTaskType = (typeof SYNC_TASK_TYPES)[number];

/** B1's own framework-level task — proves the wrapper end-to-end without touching any real
 * external API. Registered by `createDefaultRegistry()` in registry.ts. Also useful in
 * production as an ops health check ("is the dispatch path alive") independent of any sync. */
export const SYNC_NOOP = "SYNC_NOOP";
