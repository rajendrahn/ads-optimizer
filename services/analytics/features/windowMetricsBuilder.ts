// Composes one window's `WindowMetrics` document from already-computed totals — the
// aggregation (metaWindowAggregate.ts, shopifyWindowAggregate.ts) and the entity filtering
// (attribution.ts) both happen before this is called; this file only does arithmetic and
// null-vs-zero judgment calls, all pure, all documented at the point they're made.
//
// §12's metric list, delivery/traffic/funnel/business/trend, is realized here except Trend
// (trend.ts — it needs two windows, this only ever sees one).

import {
  computeAttributionCoverageRatio,
  computeBlendedMer,
  tallyResolvedOrders,
  type AttributedPurchaseCounts,
} from "@services/ingest/shopify/attribution/index.ts";
import type { WindowMetrics } from "@shared/schema/index.ts";
import type { GapAware } from "./gapAware.ts";
import type { MetaWindowTotals } from "./metaWindowAggregate.ts";
import type { ShopifyWindowTotals } from "./shopifyWindowAggregate.ts";
import type { SeasonalityContext } from "./seasonality.ts";
import { toSeasonalityContextSnapshot } from "./seasonality.ts";

function safeDiv(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export interface BuildWindowMetricsInput {
  meta: MetaWindowTotals;
  /** Sums of THIS entity's ID-resolved-only ("AD_ID") attributed orders/refunds — never
   * NAME_MATCH-pooled, per B7's contract. */
  shopifyAttributedIdOnly: GapAware<ShopifyWindowTotals>;
  /** Tally (idResolved/nameResolved/unresolved/total) over this entity's AD_ID + NAME_MATCH
   * orders — feeds `attributionCoverageRatio`/`...IncludingNameMatch`. Build via
   * `ordersAttributedToEntity(orders, entityType, entityId, graph, true)` +
   * `tallyResolvedOrders(...)`. */
  coverageTally: AttributedPurchaseCounts;
  /** Only for ACCOUNT-level docs: the account's UNCONDITIONAL Shopify totals for this window
   * (every order/refund in range, regardless of attribution — §6.3's blended MER "uses no
   * attribution at all"). `null` at every other entity level — `blendedMerAccountOnly` stays
   * null there. */
  accountUnconditionalTotals: GapAware<ShopifyWindowTotals> | null;
  /** True only when this is an AD-level doc AND `adUrlTagAudits/{adId}.resolvable === false`
   * (B7: "excluded from Shopify-attributed metrics... never silently reported as zero
   * revenue"). Every Shopify-attributed field is written `null` in that case, never `0`. */
  shopifyMetricsExcludedAsUnresolvable: boolean;
  seasonality: SeasonalityContext;
}

export function buildWindowMetrics(input: BuildWindowMetricsInput): WindowMetrics {
  const { meta } = input;
  const spend = meta.spendMinorUnits;

  const metaRoasValue = safeDiv(meta.purchaseValueMinorUnits, spend);
  const cpaValue = safeDiv(spend, meta.purchases);

  const shopifyDataGap = {
    windowHasDataGap: input.shopifyAttributedIdOnly.windowHasDataGap,
    gapDays: input.shopifyAttributedIdOnly.gapDays,
  };

  const coverage = computeAttributionCoverageRatio({
    shopifyAttributedPurchasesIdOnly: input.coverageTally.idResolved,
    shopifyAttributedPurchasesNameMatch: input.coverageTally.nameResolved,
    metaReportedPurchases: meta.purchases,
  });

  const shopify = input.shopifyMetricsExcludedAsUnresolvable
    ? null
    : input.shopifyAttributedIdOnly.value;

  const blendedMer = input.accountUnconditionalTotals
    ? computeBlendedMer({
        totalShopifyRevenueMinorUnits: input.accountUnconditionalTotals.value.netRevenueMinorUnits,
        totalMetaSpendMinorUnits: spend,
      })
    : null;

  return {
    attribution: meta.attribution,
    // Delivery
    spendMinorUnits: spend,
    impressions: meta.impressions,
    reach: meta.reach,
    frequency: safeDiv(meta.impressions, meta.reach),
    cpmMinorUnits: meta.impressions === 0 ? null : (spend * 1000) / meta.impressions,
    // Traffic
    clicks: meta.clicks,
    ctr: safeDiv(meta.clicks, meta.impressions),
    cpcMinorUnits: safeDiv(spend, meta.clicks),
    landingPageViews: meta.landingPageViews,
    // Funnel (§7.2)
    addToCart: meta.addToCart,
    checkoutStarted: meta.initiateCheckout,
    cvr: safeDiv(meta.purchases, meta.clicks),
    addToCartRate: safeDiv(meta.addToCart, meta.landingPageViews),
    checkoutStartedRate: safeDiv(meta.initiateCheckout, meta.addToCart),
    purchaseRate: safeDiv(meta.purchases, meta.initiateCheckout),
    // Business — Meta side
    purchases: {
      value: meta.purchases,
      intervalLow: null,
      intervalHigh: null,
      sampleSize: meta.purchases,
      verdict: null,
    },
    metaPurchaseValueMinorUnits: meta.purchaseValueMinorUnits,
    metaRoas: {
      value: metaRoasValue,
      intervalLow: null,
      intervalHigh: null,
      sampleSize: meta.purchases,
      verdict: null,
    },
    metaRoasShrunk: null, // §15.3 — C3's job
    // Business — Shopify side (gap-affected; null-not-zero when this ad is audit-unresolvable)
    shopifyAttributedPurchases: shopify ? shopify.ordersCount : null,
    shopifyAttributedRevenueMinorUnits: shopify ? shopify.grossRevenueMinorUnits : null,
    shopifyNetRevenueMinorUnits: shopify ? shopify.netRevenueMinorUnits : null,
    shopifyRoas: {
      value: shopify ? safeDiv(shopify.grossRevenueMinorUnits, spend) : null,
      intervalLow: null,
      intervalHigh: null,
      sampleSize: shopify ? shopify.ordersCount : 0,
      verdict: null,
    },
    shopifyRoasShrunk: null, // §15.3 — C3's job
    shopifyDataGap,
    attributionCoverageRatio: coverage.coverageRatio,
    attributionCoverageRatioIncludingNameMatch: coverage.coverageRatioIncludingNameMatch,
    cpa: {
      value: cpaValue,
      intervalLow: null,
      intervalHigh: null,
      sampleSize: meta.purchases,
      verdict: null,
    },
    aov: shopify ? safeDiv(shopify.grossRevenueMinorUnits, shopify.ordersCount) : null,
    newCustomerPercent: shopify
      ? safeDiv(shopify.newCustomerOrdersCount, shopify.ordersCount)
      : null,
    newCustomerCpaMinorUnits: shopify ? safeDiv(spend, shopify.newCustomerOrdersCount) : null,
    refundRate: shopify
      ? safeDiv(shopify.refundsAmountMinorUnits, shopify.grossRevenueMinorUnits)
      : null,
    // "Estimated" (§12's own word): attributed net revenue minus ad spend, treating 100% of net
    // revenue as contribution margin before COGS — no product-cost/margin-percent data exists
    // anywhere in this system yet (not in the reporting canon, not in any synced collection). A
    // future step wiring in real COGS data should replace this formula, not this field.
    estimatedContributionMarginMinorUnits: shopify ? shopify.netRevenueMinorUnits - spend : null,
    blendedMerAccountOnly: blendedMer,
    seasonality: toSeasonalityContextSnapshot(input.seasonality),
  };
}

export { tallyResolvedOrders };
