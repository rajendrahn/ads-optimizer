// Filters already-fetched `shopifyOrdersNormalized`/`shopifyRefundsNormalized` rows down to
// "the orders/refunds attributable to this one entity" — the pre-filter step B7's own
// `coverage.ts`/`mer.ts` expect their caller to have already done ("the caller has already
// filtered a set of resolved orders down to whatever window/entity it's asking about").
//
// ⚠️ Every filter here defaults to ID-resolved orders ONLY (`resolutionMethod === "AD_ID"`),
// per B7's binding contract ("never sum resolvedAdId-attributed revenue without filtering/
// segmenting by resolutionMethod first"). `includeNameMatch: true` is available for building
// the explicit, separately-labelled `coverageRatioIncludingNameMatch` upper bound — never used
// for `shopifyAttributedRevenueMinorUnits`/`shopifyRoas`/etc. themselves.

import type { ShopifyOrderNormalized, ShopifyRefundNormalized } from "@shared/schema/index.ts";
import type { EntityGraph } from "./entityGraph.ts";

export type FeatureEntityType = "AD" | "ADSET" | "CAMPAIGN" | "CREATIVE_FAMILY" | "ACCOUNT";

function isResolvedMethod(
  method: ShopifyOrderNormalized["resolutionMethod"],
  includeNameMatch: boolean,
): boolean {
  if (method === "AD_ID") return true;
  if (method === "NAME_MATCH") return includeNameMatch;
  return false;
}

/** True when an order (or a refund's parent order, via the same shape) resolves to `entityId`
 * at `entityType`'s altitude. ACCOUNT matches any resolved (per `includeNameMatch`) order,
 * regardless of which specific ad/campaign it names — "the account" contains all of them. */
function matchesEntity(
  order: Pick<ShopifyOrderNormalized, "resolvedAdId" | "resolvedCampaignId" | "resolutionMethod">,
  entityType: FeatureEntityType,
  entityId: string,
  graph: EntityGraph,
  includeNameMatch: boolean,
): boolean {
  if (!isResolvedMethod(order.resolutionMethod, includeNameMatch)) return false;
  switch (entityType) {
    case "ACCOUNT":
      return true;
    case "AD":
      return order.resolvedAdId === entityId;
    case "ADSET":
      return order.resolvedAdId !== null && graph.adsetByAd.get(order.resolvedAdId) === entityId;
    case "CAMPAIGN":
      if (order.resolvedCampaignId === entityId) return true;
      return order.resolvedAdId !== null && graph.campaignByAd.get(order.resolvedAdId) === entityId;
    case "CREATIVE_FAMILY":
      return order.resolvedAdId !== null && graph.familyByAd.get(order.resolvedAdId) === entityId;
  }
}

export function ordersAttributedToEntity(
  orders: readonly ShopifyOrderNormalized[],
  entityType: FeatureEntityType,
  entityId: string,
  graph: EntityGraph,
  includeNameMatch = false,
): ShopifyOrderNormalized[] {
  return orders.filter((order) =>
    matchesEntity(order, entityType, entityId, graph, includeNameMatch),
  );
}

/** orderId -> the parent order's own resolution, built from a (typically wider-than-any-single-
 * window) set of orders — a refund's own reportingDay can fall inside the current window even
 * when its parent order's does not (an order placed 40 days ago refunded yesterday), so refund
 * attribution is resolved against this index rather than against whatever order list happens to
 * be in the current window. */
export interface OrderAttributionIndex {
  byOrderId: ReadonlyMap<
    string,
    Pick<ShopifyOrderNormalized, "resolvedAdId" | "resolvedCampaignId" | "resolutionMethod">
  >;
}

export function buildOrderAttributionIndex(
  orders: readonly ShopifyOrderNormalized[],
): OrderAttributionIndex {
  const byOrderId = new Map(
    orders.map((o) => [
      o.orderId,
      {
        resolvedAdId: o.resolvedAdId,
        resolvedCampaignId: o.resolvedCampaignId,
        resolutionMethod: o.resolutionMethod,
      },
    ]),
  );
  return { byOrderId };
}

export function refundsAttributedToEntity(
  refunds: readonly ShopifyRefundNormalized[],
  index: OrderAttributionIndex,
  entityType: FeatureEntityType,
  entityId: string,
  graph: EntityGraph,
  includeNameMatch = false,
): ShopifyRefundNormalized[] {
  return refunds.filter((refund) => {
    const parent = index.byOrderId.get(refund.orderId);
    // A refund whose parent order fell outside every fetched window (older than this run's
    // lookback) has no attribution info available — excluded from every entity-level total
    // (never guessed), consistent with §6.3's "missing measurement, not absent influence": we
    // simply cannot see it, so it contributes to none of the per-ad/adset/campaign/family
    // figures. It IS still visible in the unconditional account-level totals (blended MER,
    // shopifyDailyCoverage), which never filter by attribution at all.
    if (!parent) return false;
    return matchesEntity(parent, entityType, entityId, graph, includeNameMatch);
  });
}
