// Collection names (§8) and deterministic document-key helpers (§9.5).
//
// "Later steps must never hand-build a document ID" (IMPLEMENTATION_PLAN.md A2) — every
// collection whose key is determined by its own data gets a helper here. A few collections
// generate their own ID at write time rather than deriving one (recommendations, syncRuns,
// decisionPackets, creativeFamilies, backtestRuns, aiConversations, accountMemory) — those
// are noted below rather than given a fabricated helper, since guessing an ID scheme for
// them is a later step's judgment call, not A2's.
//
// firestore.indexes.json carries a starting set of composite indexes for the query
// patterns clearly implied by the design (JSON has no comment syntax, so the rationale
// lives here instead):
//   - metaInsightsDaily (adId|adsetId|campaignId, date) — B3 reconciliation, C1/C2 windowing
//     at all three altitudes §12 computes at.
//   - metaChangeEvents (entityId, field, detectedAt desc) — §13's hoursSinceLast*/
//     …ChangesLastNDays family: "most recent change of field X for entity Y".
//   - shopifyOrders (customerId, createdAt asc) — B5's new-vs-repeat derivation: group by
//     customer, sort by order date, first = new (§7.2).
//   - recommendations (status, createdAt desc) — D4/D6 listing PENDING/recent recommendations.
//   - syncRuns (taskType, startedAt desc) — B1's "most recent run of type X" lifecycle checks.
// This is a starting point, not exhaustive — Firestore's own emulator/console error message
// on a missing index names the exact index needed and links to auto-create it; extend this
// file as real queries land in B/C/D.

/** Every collection in §8, by its exact Firestore collection name. */
export const COLLECTIONS = {
  metaCampaigns: "metaCampaigns",
  metaAdsets: "metaAdsets",
  metaAds: "metaAds",
  metaCreatives: "metaCreatives",
  metaInsightsDaily: "metaInsightsDaily",
  metaEntitySnapshots: "metaEntitySnapshots",
  metaChangeEvents: "metaChangeEvents",
  // B3's async-report-job bookkeeping — not one of §8's named collections; see
  // shared/schema/meta.ts's module comment on metaInsightsReportJobSchema for why.
  metaInsightsReportJobs: "metaInsightsReportJobs",

  shopifyOrders: "shopifyOrders",
  shopifyOrderLines: "shopifyOrderLines",
  shopifyRefunds: "shopifyRefunds",

  creativeAssets: "creativeAssets",
  creativeFamilies: "creativeFamilies",

  adFeatures: "adFeatures",
  adsetFeatures: "adsetFeatures",
  accountFeatures: "accountFeatures",

  decisionPackets: "decisionPackets",
  recommendations: "recommendations",
  recommendationOutcomes: "recommendationOutcomes",

  syncState: "syncState",
  syncRuns: "syncRuns",
  backtestRuns: "backtestRuns",

  aiConversations: "aiConversations",
  accountMemory: "accountMemory",
  settings: "settings",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/**
 * A Firestore document ID may not be empty, "." or "..", contain a "/", or match the
 * pattern `__.*__`. Key helpers below only ever join plain platform IDs and dates with "_",
 * so in practice the only realistic mistake is an empty segment — that's what this guards.
 */
function assertValidIdSegment(segment: string, label: string): string {
  if (segment.length === 0) {
    throw new Error(`Firestore key segment "${label}" must not be empty`);
  }
  if (segment.includes("/")) {
    throw new Error(`Firestore key segment "${label}" must not contain "/": ${segment}`);
  }
  return segment;
}

// ---------------------------------------------------------------------------------------
// Entities keyed directly by Meta's own platform ID — no helper needed, just use the ID:
// metaCampaigns/{campaignId}, metaAdsets/{adsetId}, metaAds/{adId}, metaCreatives/{creativeId},
// metaInsightsReportJobs/{reportRunId} (Meta's own async report job id — naturally idempotent:
// re-submitting the same window twice cannot collide since Meta mints a fresh id per submission,
// and every phase transition of one job writes to the same doc keyed by its own id)
// ---------------------------------------------------------------------------------------

/** metaInsightsDaily/{adId}_{date} — §9.5's given example. `date` is a reportingDay string. */
export function metaInsightsDailyKey(adId: string, date: string): string {
  assertValidIdSegment(adId, "adId");
  assertValidIdSegment(date, "date");
  return `${adId}_${date}`;
}

/**
 * metaEntitySnapshots/{entityType}_{entityId}_{syncRunId} — ties a snapshot to the run that
 * produced it, so retrying a failed sync run overwrites its own partial snapshot rather than
 * accumulating duplicates (§10.2: "each task is idempotent"). B2 owns when a snapshot is
 * actually taken; this only fixes the ID format.
 */
export function metaEntitySnapshotKey(
  entityType: "CAMPAIGN" | "ADSET" | "AD",
  entityId: string,
  syncRunId: string,
): string {
  assertValidIdSegment(entityId, "entityId");
  assertValidIdSegment(syncRunId, "syncRunId");
  return `${entityType}_${entityId}_${syncRunId}`;
}

/**
 * metaChangeEvents/{entityType}_{entityId}_{field}_{toSnapshotKey} — deterministic in the
 * diffed snapshot pair, so re-running the diff for the same pair of snapshots (a retried
 * B4 task) produces the same event ID rather than a duplicate.
 */
export function metaChangeEventKey(
  entityType: "CAMPAIGN" | "ADSET" | "AD",
  entityId: string,
  field: string,
  toSnapshotKey: string,
): string {
  assertValidIdSegment(entityId, "entityId");
  assertValidIdSegment(field, "field");
  assertValidIdSegment(toSnapshotKey, "toSnapshotKey");
  return `${entityType}_${entityId}_${field}_${toSnapshotKey}`;
}

/** shopifyOrders/{shopifyOrderId} — §9.5's given example; use the ID directly, no helper. */

/** shopifyOrderLines/{shopifyOrderId}_{lineItemId} */
export function shopifyOrderLineKey(orderId: string, lineItemId: string): string {
  assertValidIdSegment(orderId, "orderId");
  assertValidIdSegment(lineItemId, "lineItemId");
  return `${orderId}_${lineItemId}`;
}

/** shopifyRefunds/{shopifyOrderId}_{refundId} */
export function shopifyRefundKey(orderId: string, refundId: string): string {
  assertValidIdSegment(orderId, "orderId");
  assertValidIdSegment(refundId, "refundId");
  return `${orderId}_${refundId}`;
}

/** creativeAssets/{assetHash} — §9.5's given example; use the hash directly, no helper. */

// creativeFamilies/{familyId} — B8's grouping logic decides which asset seeds a family
// (and how membership evolves as near-duplicates join it); no helper here, any non-empty
// string ID is accepted by the repository layer.

/** adFeatures/{adId}, adsetFeatures/{adsetId} — use the entity's own ID directly. */

/** accountFeatures/{accountId}, settings/{accountId} — use the real Meta ad account ID
 * directly (not a magic singleton string), consistent with every other level using its own
 * platform ID. There is exactly one account (§8: "one brand, one ad account"), so this and
 * a fixed literal are equivalent in practice — the real ID was preferred as the more
 * consistent convention. */

/** recommendationOutcomes/{recommendationId} — 1:1 with the recommendation it evaluates. */
export function recommendationOutcomeKey(recommendationId: string): string {
  return assertValidIdSegment(recommendationId, "recommendationId");
}

/** syncState/{source}_{resource} — §9.3's example shape. */
export function syncStateKey(source: "meta" | "shopify", resource: string): string {
  assertValidIdSegment(resource, "resource");
  return `${source}_${resource}`;
}

// decisionPackets/{id}, recommendations/{id}, backtestRuns/{id}, aiConversations/{id},
// accountMemory/{id} — each generates its own ID at write time (a request UUID, etc.), not
// derived from source data. Later steps that own those ID schemes should add a helper here
// rather than hand-building one inline, to keep this file the single place document IDs are
// decided.

// syncRuns/{runId} — B1 decided this ID scheme: `runId` is the task's own idempotency key,
// supplied by whatever enqueues the task (services/ingest/sync/taskQueue.ts) or generated
// fresh (crypto.randomUUID()) when none is given. It is deliberately NOT derived from
// (taskType, inputs) the way the keys above are — a retried/redelivered task reuses the SAME
// runId on purpose, so services/ingest/sync/taskWrapper.ts's `runSyncTask` can look the doc up
// by that id and treat an already-SUCCEEDED one as a no-op (§10.2's idempotency requirement).
// See services/ingest/sync/taskWrapper.ts's module comment for the full lifecycle.
