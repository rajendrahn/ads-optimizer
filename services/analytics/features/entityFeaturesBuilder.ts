// Builds one entity's full `EntityFeatures` document: every §4.2 window's `WindowMetrics`, plus
// §12's Trend. Pure composition over data the caller has already fetched for the whole account —
// see recomputeFeaturesTask.ts for where `FeatureComputationContext` actually gets built (one
// Firestore read pass for the whole account, reused across every entity/window this computes).
//
// §13 (changeAware) and §13.1 (learningPhase) are explicitly C4's job (IMPLEMENTATION_PLAN.md
// C2's Out-of-scope line) — every entity doc is written with both as `{}` (every field on those
// two sub-objects is `.partial()`, so an empty object is valid, not a placeholder hack).

import type {
  EntityFeatures,
  MetaInsightsDailyNormalized,
  ReportingDay,
  ShopifyDailyCoverage,
  ShopifyOrderNormalized,
  ShopifyRefundNormalized,
} from "@shared/schema/index.ts";
import { tallyResolvedOrders } from "@services/ingest/shopify/attribution/index.ts";
import {
  ordersAttributedToEntity,
  refundsAttributedToEntity,
  type FeatureEntityType,
  type OrderAttributionIndex,
} from "./attribution.ts";
import type { EntityGraph } from "./entityGraph.ts";
import { aggregateMetaWindow, type MetaWindowTotals } from "./metaWindowAggregate.ts";
import { aggregateShopifyWindow } from "./shopifyWindowAggregate.ts";
import { buildWindowMetrics } from "./windowMetricsBuilder.ts";
import { computeTrend } from "./trend.ts";
import { resolveSeasonalityContext, type SeasonalityContextProvider } from "./seasonality.ts";
import {
  ALL_WINDOW_LABELS,
  allWindowsEnding,
  previousEquivalentWindow,
  type DayRange,
} from "./windows.ts";

export interface FeatureComputationContext {
  reportingCurrency: string;
  accountId: string;
  accountDataVersion: number;
  computedAt: Date;
  graph: EntityGraph;
  /** Every metaInsightsDailyNormalized row in the full lookback range (widest window + the
   * previous-7d trend window) — NOT pre-filtered to one entity. */
  allMetaRows: readonly MetaInsightsDailyNormalized[];
  allShopifyOrders: readonly ShopifyOrderNormalized[];
  allShopifyRefunds: readonly ShopifyRefundNormalized[];
  coverageByDay: ReadonlyMap<ReportingDay, ShopifyDailyCoverage>;
  orderAttributionIndex: OrderAttributionIndex;
  /** adIds the URL-tag audit (B7) found unresolvable — excluded from Shopify-attributed
   * metrics at AD level only (§6.3). */
  unresolvableAdIds: ReadonlySet<string>;
  seasonalityProvider?: SeasonalityContextProvider;
}

function metaRowsForEntity(
  rows: readonly MetaInsightsDailyNormalized[],
  entityType: FeatureEntityType,
  entityId: string,
  graph: EntityGraph,
): MetaInsightsDailyNormalized[] {
  switch (entityType) {
    case "AD":
      return rows.filter((r) => r.adId === entityId);
    case "ADSET":
      return rows.filter((r) => r.adsetId === entityId);
    case "CAMPAIGN":
      return rows.filter((r) => r.campaignId === entityId);
    case "ACCOUNT":
      return rows.slice();
    case "CREATIVE_FAMILY":
      return rows.filter((r) => graph.familyByAd.get(r.adId) === entityId);
  }
}

function inDayRange(day: ReportingDay, range: DayRange): boolean {
  return day >= range.startDay && day <= range.endDay;
}

async function computeOneWindow(
  entityType: FeatureEntityType,
  entityId: string,
  window: DayRange,
  ctx: FeatureComputationContext,
) {
  const metaRows = metaRowsForEntity(ctx.allMetaRows, entityType, entityId, ctx.graph).filter((r) =>
    inDayRange(r.reportingDay, window),
  );
  const meta = aggregateMetaWindow(metaRows, ctx.reportingCurrency);

  const ordersInWindow = ctx.allShopifyOrders.filter((o) => inDayRange(o.reportingDay, window));
  const refundsInWindow = ctx.allShopifyRefunds.filter((r) => inDayRange(r.reportingDay, window));

  // ID + NAME_MATCH together, for the coverage tally's two buckets (never pooled downstream).
  const entityOrdersAnyMethod = ordersAttributedToEntity(
    ordersInWindow,
    entityType,
    entityId,
    ctx.graph,
    true,
  );
  // `ordersAttributedToEntity` already guarantees every surviving order has resolutionMethod
  // "AD_ID" or "NAME_MATCH" at runtime (isResolvedMethod excludes null/undefined/"UNRESOLVED") —
  // this map only narrows the TYPE to match, since the field stays optional/nullable on
  // ShopifyOrderNormalized for orders SHOPIFY_RESOLVE_ATTRIBUTION hasn't reached yet.
  const coverageTally = tallyResolvedOrders(
    entityOrdersAnyMethod.map((o) => ({ resolutionMethod: o.resolutionMethod ?? "UNRESOLVED" })),
  );
  const entityOrdersIdOnly = entityOrdersAnyMethod.filter((o) => o.resolutionMethod === "AD_ID");
  const entityRefundsIdOnly = refundsAttributedToEntity(
    refundsInWindow,
    ctx.orderAttributionIndex,
    entityType,
    entityId,
    ctx.graph,
    false,
  );
  const shopifyAttributedIdOnly = aggregateShopifyWindow(
    entityOrdersIdOnly,
    entityRefundsIdOnly,
    ctx.coverageByDay,
    window,
    ctx.reportingCurrency,
  );

  const accountUnconditionalTotals =
    entityType === "ACCOUNT"
      ? aggregateShopifyWindow(
          ordersInWindow,
          refundsInWindow,
          ctx.coverageByDay,
          window,
          ctx.reportingCurrency,
        )
      : null;

  const seasonality = await resolveSeasonalityContext(
    ctx.seasonalityProvider,
    window,
    previousEquivalentWindow(window),
  );

  const windowMetrics = buildWindowMetrics({
    meta,
    shopifyAttributedIdOnly,
    coverageTally,
    accountUnconditionalTotals,
    shopifyMetricsExcludedAsUnresolvable:
      entityType === "AD" && ctx.unresolvableAdIds.has(entityId),
    seasonality,
  });

  return { windowMetrics, meta };
}

export async function buildEntityFeatures(
  entityType: FeatureEntityType,
  entityId: string,
  asOfDay: ReportingDay,
  ctx: FeatureComputationContext,
): Promise<EntityFeatures> {
  const windows = allWindowsEnding(asOfDay);

  const windowsOut: EntityFeatures["windows"] = {};
  let current7dMeta: MetaWindowTotals | null = null;

  for (const label of ALL_WINDOW_LABELS) {
    const { windowMetrics, meta } = await computeOneWindow(
      entityType,
      entityId,
      windows[label],
      ctx,
    );
    windowsOut[label] = windowMetrics;
    if (label === "7d") current7dMeta = meta;
  }

  // Trend: current-7d vs. the immediately preceding 7d — computed from raw Meta totals only
  // (trend.ts's own module comment explains why a second full WindowMetrics isn't needed here).
  const previous7dRange = previousEquivalentWindow(windows["7d"]);
  const previous7dMetaRows = metaRowsForEntity(
    ctx.allMetaRows,
    entityType,
    entityId,
    ctx.graph,
  ).filter((r) => inDayRange(r.reportingDay, previous7dRange));
  const previous7dMeta = aggregateMetaWindow(previous7dMetaRows, ctx.reportingCurrency);
  const trend = computeTrend(current7dMeta as MetaWindowTotals, previous7dMeta);

  return {
    entityId,
    entityType,
    accountDataVersion: ctx.accountDataVersion,
    computedAt: ctx.computedAt,
    windows: windowsOut,
    trend,
    changeAware: {}, // C4
    learningPhase: {}, // C4
  };
}
