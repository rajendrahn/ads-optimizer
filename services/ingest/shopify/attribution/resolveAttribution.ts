// SHOPIFY_RESOLVE_ATTRIBUTION — B7's actual join (§6.1), wired into the task framework.
//
// Not one of §10.2's original task types (like B5's SHOPIFY_IMPORT_ORDERS_CSV before it — see
// taskTypes.ts) — added here because §10.2 never named a task for the order-side half of the
// join, only for the ad-side audit (AUDIT_AD_URL_TAGS). A deliberate choice, recorded because
// B4/B2 set a different precedent (folding change-event derivation directly into
// META_SNAPSHOT_CONFIG's own handler): this join instead gets its OWN task type rather than
// being spliced into B5's already-"Done" `ordersSync.ts`/`matrixifyImport.ts` handlers. Two
// reasons: (1) B6 (webhooks) and B8 (creative identity) are running concurrently against
// adjacent Shopify/Meta files per this step's own safety constraints, and editing B5's
// already-complete task handlers is unnecessary surface area to conflict over when a
// standalone task achieves the same outcome; (2) attribution resolution's inputs
// (`metaAds`/`metaCampaigns` names, which can be renamed) can change independently of any new
// order arriving, so a resolution that's correct today can become wrong (or newly resolvable)
// tomorrow purely because Meta's config changed — a full, independently re-runnable/schedulable
// pass (§10.1's "full recompute" precedent, exactly like `recomputeAndPersistNewVsRepeat`) is
// the honest way to keep it current, not a one-shot computed-at-ingest-time value.
//
// `recomputeAndPersistAttribution` mirrors newVsRepeat.ts's shape deliberately: read every
// order, recompute in memory, write back only what changed, through the same A2 version guard
// using each order's own already-stored `sourceUpdatedAt` (an equal-version write, accepted per
// that guard's documented idempotency rule).

import {
  collectionRef,
  COLLECTIONS,
  upsertWithVersionGuard,
  getDb,
} from "@shared/firestore/index.ts";
import { shopifyOrderSchema, type ShopifyOrder } from "@shared/schema/index.ts";
import type { Firestore } from "firebase-admin/firestore";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import { buildAttributionIndex } from "./attributionIndex.ts";
import { resolveOrderAttribution } from "./resolveOrder.ts";

export interface RecomputeAttributionResult {
  ordersScanned: number;
  ordersWithLandingSite: number;
  changed: number;
  resolvedByAdId: number;
  resolvedByNameMatch: number;
  unresolved: number;
  /** Orders where a NAME_MATCH attempt hit more than one candidate entity — never resolved,
   * always surfaced instead of guessed. Bounded for the same reason
   * urlAudit.ts's `unresolvableAdIdsSample` is. */
  ambiguousSample: { orderId: string; rawAttributionTag: string | null; candidateIds: string[] }[];
}

const AMBIGUOUS_SAMPLE_LIMIT = 50;

export async function recomputeAndPersistAttribution(
  db: Firestore,
): Promise<RecomputeAttributionResult> {
  const [index, ordersSnap] = await Promise.all([
    buildAttributionIndex(db),
    collectionRef(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema).get(),
  ]);
  const allOrders: ShopifyOrder[] = ordersSnap.docs.map((d) => d.data());
  const withLandingSite = allOrders.filter((o) => o.landingSite !== null);

  let changed = 0;
  let resolvedByAdId = 0;
  let resolvedByNameMatch = 0;
  let unresolved = 0;
  const ambiguousSample: RecomputeAttributionResult["ambiguousSample"] = [];

  for (const order of allOrders) {
    const resolution = resolveOrderAttribution(order.landingSite, index);

    if (resolution.resolutionMethod === "AD_ID") resolvedByAdId++;
    else if (resolution.resolutionMethod === "NAME_MATCH") resolvedByNameMatch++;
    else unresolved++;

    if (
      resolution.ambiguousNameCandidateIds !== null &&
      ambiguousSample.length < AMBIGUOUS_SAMPLE_LIMIT
    ) {
      ambiguousSample.push({
        orderId: order.orderId,
        rawAttributionTag: resolution.rawAttributionTag,
        candidateIds: resolution.ambiguousNameCandidateIds,
      });
    }

    const nothingChanged =
      order.rawAttributionTag === resolution.rawAttributionTag &&
      order.resolvedAdId === resolution.resolvedAdId &&
      order.resolvedCampaignId === resolution.resolvedCampaignId &&
      (order.resolutionMethod ?? null) === resolution.resolutionMethod &&
      (order.resolutionConfidence ?? null) === resolution.resolutionConfidence;
    if (nothingChanged) continue;

    changed++;
    await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.shopifyOrders,
      docId: order.orderId,
      incoming: {
        ...order,
        rawAttributionTag: resolution.rawAttributionTag,
        resolvedAdId: resolution.resolvedAdId,
        resolvedCampaignId: resolution.resolvedCampaignId,
        resolutionMethod: resolution.resolutionMethod,
        resolutionConfidence: resolution.resolutionConfidence,
      },
      schema: shopifyOrderSchema,
    });
  }

  return {
    ordersScanned: allOrders.length,
    ordersWithLandingSite: withLandingSite.length,
    changed,
    resolvedByAdId,
    resolvedByNameMatch,
    unresolved,
    ambiguousSample,
  };
}

// ---------------------------------------------------------------------------------------
// SHOPIFY_RESOLVE_ATTRIBUTION task registration. No Meta/Shopify client used — a Firestore-to-
// Firestore join over data B2/B5 already ingested. `runSource: "internal"`, no watermark: like
// newVsRepeat, this is a full recompute over the accumulated dataset every run, not an
// incremental sync against an external source.
// ---------------------------------------------------------------------------------------

export const shopifyResolveAttributionHandler: TaskHandler = async () => {
  const db = getDb();
  const result = await recomputeAndPersistAttribution(db);
  return {
    newRowCount: result.changed,
    summary: {
      ordersScanned: result.ordersScanned,
      ordersWithLandingSite: result.ordersWithLandingSite,
      changed: result.changed,
      resolvedByAdId: result.resolvedByAdId,
      resolvedByNameMatch: result.resolvedByNameMatch,
      unresolved: result.unresolved,
      ambiguousSample: result.ambiguousSample,
    },
  };
};

export const shopifyResolveAttributionRegistration: TaskRegistration = {
  taskType: "SHOPIFY_RESOLVE_ATTRIBUTION",
  runSource: "internal",
  syncStateTarget: null,
  handler: shopifyResolveAttributionHandler,
};
