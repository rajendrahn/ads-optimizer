// Builds a per-ad-set, per-window evidence snapshot from reconstructed Meta insights rows,
// reusing C2's real window aggregation/composition (`aggregateMetaWindow`, `buildWindowMetrics`)
// and C3's real statistical layer (`computeWindowStatistics`) UNCHANGED — the same numeric core
// production uses, just fed with point-in-time-reconstructed rows instead of a live Firestore
// read. This is what makes the backtest's decision a genuine test of "would the account's own
// eligibility/verdict machinery have said yes here", not a bespoke reimplementation that could
// silently drift from what D1/C3 actually compute.
//
// Deliberately does NOT reconstruct Shopify per-entity attribution (see reconstructShopify.ts's
// own module comment on why — ~0.02% real coverage, B7). Every ad set's Shopify-side totals are
// a genuine, explicit zero (`markGap(zeroTotals, false, [])`), never a fabricated non-zero
// number — `buildWindowMetrics` treats that exactly like "no Shopify orders resolved to this
// entity in this window", which is honestly what E1 knows. `eligibility.ts`'s own
// `computeEligibilityAndRange` never reads `shopifyRoas` for exactly this reason (D1's own
// Reality #4) — see this step's report for why Meta-attributed metaRoas/cpa plus account-level
// blended MER is the right outcome measure at this account's real attribution coverage.
//
// Does NOT reconstruct Meta entity config (budget ownership, CBO/ABO) either — every ad set
// present in the reconstructed insights rows is treated as its own decision unit. This is a
// documented scope cut (see this step's report and IMPLEMENTATION_PLAN.md notes): D1's real
// `budgetOwnerResolution.ts` requires reconstructing `metaCampaigns`/`metaAdsets` from the
// archive's "campaigns"/"adsets" resources too, which E1 does not attempt.

import {
  aggregateMetaWindow,
  buildWindowMetrics,
  markGap,
  NULL_SEASONALITY_CONTEXT,
  type DayRange,
  type MetaWindowTotals,
  type SeasonalityContext,
  type ShopifyWindowTotals,
} from "@services/analytics/features/index.ts";
import {
  computeWindowStatistics,
  type AccountMeansForWindow,
  type WindowStatisticalThresholds,
  type WindowStatisticsPatch,
} from "@services/analytics/statistics/index.ts";
import type { MetaInsightsDailyNormalized, WindowMetrics } from "@shared/schema/index.ts";

const ZERO_SHOPIFY_TOTALS: ShopifyWindowTotals = {
  currency: "INR",
  ordersCount: 0,
  newCustomerOrdersCount: 0,
  grossRevenueMinorUnits: 0,
  refundsAmountMinorUnits: 0,
  netRevenueMinorUnits: 0,
};

function rowsInWindow(
  rows: readonly MetaInsightsDailyNormalized[],
  window: DayRange,
): MetaInsightsDailyNormalized[] {
  return rows.filter((r) => r.reportingDay >= window.startDay && r.reportingDay <= window.endDay);
}

export interface AdSetWindowEvidence {
  adsetId: string;
  window: DayRange;
  meta: MetaWindowTotals;
  windowMetrics: WindowMetrics;
  stats: WindowStatisticsPatch;
  /** `meta.purchases > 0 || meta.spendMinorUnits > 0` — D1's own `isDelivering` definition
   * (deliveryCheck.ts), reused by name here so the two can never silently disagree about what
   * "not delivering" means. */
  isDelivering: boolean;
}

/** Groups reconstructed Meta rows by ad set. */
export function groupMetaRowsByAdset(
  rows: readonly MetaInsightsDailyNormalized[],
): Map<string, MetaInsightsDailyNormalized[]> {
  const byAdset = new Map<string, MetaInsightsDailyNormalized[]>();
  for (const row of rows) {
    const list = byAdset.get(row.adsetId);
    if (list) list.push(row);
    else byAdset.set(row.adsetId, [row]);
  }
  return byAdset;
}

/** The account's own metaRoas for the same window — "the account's ROAS in the same window" that
 * §15.3 shrinkage weighs each ad set's own number against. Computed over every reconstructed row
 * (all ad sets combined), matching C2's own account-level aggregation. */
export function computeAccountMetaMeans(
  allRows: readonly MetaInsightsDailyNormalized[],
  window: DayRange,
  reportingCurrency: string,
): AccountMeansForWindow {
  const totals = aggregateMetaWindow(rowsInWindow(allRows, window), reportingCurrency);
  const metaRoas =
    totals.spendMinorUnits === 0 ? null : totals.purchaseValueMinorUnits / totals.spendMinorUnits;
  return { metaRoas, shopifyRoas: null };
}

export interface BuildAdSetWindowEvidenceInput {
  adsetId: string;
  rows: readonly MetaInsightsDailyNormalized[];
  window: DayRange;
  reportingCurrency: string;
  accountMeans: AccountMeansForWindow;
  thresholds: WindowStatisticalThresholds;
  seasonality?: SeasonalityContext;
}

export function buildAdSetWindowEvidence(
  input: BuildAdSetWindowEvidenceInput,
): AdSetWindowEvidence {
  const windowed = rowsInWindow(input.rows, input.window);
  const meta = aggregateMetaWindow(windowed, input.reportingCurrency);

  const windowMetrics = buildWindowMetrics({
    meta,
    shopifyAttributedIdOnly: markGap(ZERO_SHOPIFY_TOTALS, false, []),
    coverageTally: { idResolved: 0, nameResolved: 0, unresolved: 0, total: 0 },
    accountUnconditionalTotals: null,
    shopifyMetricsExcludedAsUnresolvable: false,
    seasonality: input.seasonality ?? NULL_SEASONALITY_CONTEXT,
  });

  const stats = computeWindowStatistics(windowMetrics, input.accountMeans, input.thresholds);

  return {
    adsetId: input.adsetId,
    window: input.window,
    meta,
    windowMetrics,
    stats,
    isDelivering: meta.spendMinorUnits > 0 || meta.impressions > 0,
  };
}
