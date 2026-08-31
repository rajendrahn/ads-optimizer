// Sums already entity/window-filtered `metaInsightsDailyNormalized` rows into a window total.
// No gap wrapper here — deliberately: the Shopify coverage hole (B5/C1) is Shopify-side only,
// "Meta-only figures in the same window are unaffected" (IMPLEMENTATION_PLAN.md C2's brief,
// repeating C1's own note). A plain `MetaWindowTotals` is the honest return type; wrapping it in
// `GapAware` would imply a gap concept that does not apply to this data source.

import type { AttributionProvenance, MetaInsightsDailyNormalized } from "@shared/schema/index.ts";

function sameAttribution(a: AttributionProvenance, b: AttributionProvenance): boolean {
  return (
    a.attributionWindow === b.attributionWindow && a.purchaseActionType === b.purchaseActionType
  );
}

export interface MetaWindowTotals {
  currency: string;
  /**
   * §5.3: "Store both [attribution window and purchase action type] on every insight document.
   * They are part of the measurement, not configuration." Carried through from the underlying
   * `metaInsightsDailyNormalized` rows verbatim, never re-derived or defaulted — `null` when the
   * window has no rows at all, OR when the rows disagree (the canon changed mid-window — §5.3's
   * own "emit a first-class change event... invalidate trend features that span the boundary"
   * case). A `null` here is the honest signal that this window's purchase/ROAS figures are not
   * safely comparable to another window's under a DIFFERENT attribution setting; it is never
   * silently picked as "whichever came first".
   */
  attribution: AttributionProvenance | null;
  spendMinorUnits: number;
  impressions: number;
  /** Sum of each day's own reported reach. This is a documented approximation, not true
   * window-level unique reach: Meta reports reach per day (unique people that day), and summing
   * across days double-counts anyone who saw the ad on more than one day in the window — there
   * is no de-duplication available from daily-grain data alone. Treat this (and the `frequency`
   * derived from it) as an upper-bound-on-uniques / lower-bound-on-frequency approximation, not
   * a precise window reach. A real window-level reach would require Meta's own window-level
   * insights query (a different API call this step did not add — out of scope: this step
   * consumes metaInsightsDailyNormalized as C1 already produced it, one row per ad-day). */
  reach: number;
  clicks: number;
  landingPageViews: number;
  addToCart: number;
  initiateCheckout: number;
  purchases: number;
  purchaseValueMinorUnits: number;
}

function zeroTotals(currency: string): MetaWindowTotals {
  return {
    currency,
    attribution: null,
    spendMinorUnits: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    landingPageViews: 0,
    addToCart: 0,
    initiateCheckout: 0,
    purchases: 0,
    purchaseValueMinorUnits: 0,
  };
}

export function aggregateMetaWindow(
  rows: readonly MetaInsightsDailyNormalized[],
  reportingCurrency: string,
): MetaWindowTotals {
  const totals = zeroTotals(reportingCurrency);
  let attributionDisagrees = false;
  for (const row of rows) {
    if (row.spend.currency !== reportingCurrency) {
      throw new Error(
        `aggregateMetaWindow: row ${row.adId}_${row.reportingDay} currency ${row.spend.currency} != reporting currency ${reportingCurrency}`,
      );
    }
    if (totals.attribution === null) {
      totals.attribution = row.attribution;
    } else if (!sameAttribution(totals.attribution, row.attribution)) {
      attributionDisagrees = true;
    }
    totals.spendMinorUnits += row.spend.amountMinorUnits;
    totals.impressions += row.impressions;
    totals.reach += row.reach ?? 0;
    totals.clicks += row.clicks;
    totals.landingPageViews += row.landingPageViews;
    totals.addToCart += row.addToCart;
    totals.initiateCheckout += row.initiateCheckout;
    totals.purchases += row.purchases;
    totals.purchaseValueMinorUnits += row.purchaseValue.amountMinorUnits;
  }
  if (attributionDisagrees) totals.attribution = null;
  return totals;
}
