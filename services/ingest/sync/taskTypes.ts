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
  // B8's addition — not in §10.2's original list, and deliberately distinct from
  // PROCESS_CREATIVE (which names Phase F's expensive download/OCR/embedding pipeline, §11.2).
  // This is §11.1's cheap identity grouping: Firestore-only (reads B2's `metaCreatives`, no
  // live Meta call, no archiving), so it earned its own task type rather than overloading
  // PROCESS_CREATIVE with a much lighter-weight operation Phase F would otherwise have to
  // special-case around.
  "META_SYNC_CREATIVE_IDENTITY",
  // B6's addition — not in §10.2's original list. Shopify webhook deliveries (order
  // create/update/cancel, refund create) are processed by this task type after receiver.ts
  // verifies the HMAC and enqueues them; it is intentionally distinct from SHOPIFY_SYNC_ORDERS
  // (that task owns the hourly/on-demand incremental *sync* and `syncState/shopify_orders`'s
  // watermark — §25 lists "Shopify webhooks" and "Shopify reconciliation" as two separate
  // schedule rows). See services/ingest/shopify/webhooks/processTask.ts's module comment.
  "SHOPIFY_PROCESS_WEBHOOK",
  // B7's addition — not in §10.2's original list, which named AUDIT_AD_URL_TAGS (registered
  // as-is, below) but no task for the order-side half of the join. See
  // services/ingest/shopify/attribution/resolveAttribution.ts's module comment for why this is
  // its own task type rather than folded into B5's SHOPIFY_SYNC_ORDERS/SHOPIFY_IMPORT_ORDERS_CSV
  // handlers.
  "SHOPIFY_RESOLVE_ATTRIBUTION",
  // C1's additions — not in §10.2's original list. Re-express already-synced Meta/Shopify data
  // onto the canon reporting day/currency (§5); see services/analytics/daily/
  // normalizeMetaDailyTask.ts and normalizeShopifyDailyTask.ts's own module comments for why
  // this is a Firestore-to-Firestore re-derivation task, not a live-API sync, and why Meta and
  // Shopify each get their own independently-retriable task type rather than one combined task.
  "NORMALIZE_META_INSIGHTS_DAILY",
  "NORMALIZE_SHOPIFY_DAILY",
] as const;
export type KnownTaskType = (typeof SYNC_TASK_TYPES)[number];

/** B1's own framework-level task — proves the wrapper end-to-end without touching any real
 * external API. Registered by `createDefaultRegistry()` in registry.ts. Also useful in
 * production as an ops health check ("is the dispatch path alive") independent of any sync. */
export const SYNC_NOOP = "SYNC_NOOP";
