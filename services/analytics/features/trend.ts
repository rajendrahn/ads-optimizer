// §12 Trend — "change versus previous equivalent window ... spend velocity; purchase volume
// trend." §4.2 designates 7d as the trend window explicitly ("Secondary. Trend direction only,
// never a threshold test") and `trendMetrics` (shared/schema/features.ts) is a single flat
// object on `EntityFeatures`, not nested per window the way `windows` is — so C2 computes trend
// as current-7d vs. the immediately preceding 7d, once per entity, rather than once per window
// label. (Ambiguity resolved: §12's wording doesn't pin trend to a specific window; 7d is the
// one window §4.2 itself calls "trend direction only", so it is the natural, and only
// unambiguous, choice.)
//
// Computed directly from two `MetaWindowTotals` (current-7d, previous-7d) rather than two full
// `WindowMetrics` — every field §12 lists for Trend (ROAS, CPA, CTR, CVR, CPM, frequency, spend
// velocity, purchase volume) is derivable from Meta's own delivery numbers alone, so building a
// second full WindowMetrics (which would also filter Shopify orders/refunds and call the
// seasonality provider, neither used here) for the sole purpose of computing trend would be
// pointless extra work. Uses Meta-attributed ROAS/CPA as the trend reference, not Shopify's —
// Shopify-attributed figures are both gap-affected and, at this account's near-zero coverage,
// dominated by join noise rather than real performance movement; a Meta-attributed trend is the
// stable signal, matching §14's own evidence example (`roas28d`/`cpa28d` read as Meta figures
// there too).

import type { TrendMetrics } from "@shared/schema/index.ts";
import type { MetaWindowTotals } from "./metaWindowAggregate.ts";

/** Percent change from `previous` to `current`, `(current - previous) / |previous| * 100`.
 * `null` when `previous` is `0` — an undefined percent change, never a fabricated one (e.g.
 * 0 -> 5 is not "infinite percent", it's "not computable this way"). */
function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function percentChangeNullable(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return percentChange(current, previous);
}

/** UP/DOWN/STABLE by a flat ±10% purchase-count band — deliberately simple (this step's own
 * brief: "prefer clarity over cleverness"); C3 layers statistical significance on top of raw
 * metric values elsewhere, not here. `null` when there is nothing to compare (both windows had
 * zero purchases). */
function purchaseVolumeTrend(
  currentPurchases: number,
  previousPurchases: number,
): "UP" | "DOWN" | "STABLE" | null {
  if (previousPurchases === 0) return currentPurchases === 0 ? null : "UP";
  const change = (currentPurchases - previousPurchases) / previousPurchases;
  if (change > 0.1) return "UP";
  if (change < -0.1) return "DOWN";
  return "STABLE";
}

function roas(totals: MetaWindowTotals): number | null {
  return totals.spendMinorUnits === 0
    ? null
    : totals.purchaseValueMinorUnits / totals.spendMinorUnits;
}
function cpa(totals: MetaWindowTotals): number | null {
  return totals.purchases === 0 ? null : totals.spendMinorUnits / totals.purchases;
}
function ctr(totals: MetaWindowTotals): number | null {
  return totals.impressions === 0 ? null : totals.clicks / totals.impressions;
}
function cvr(totals: MetaWindowTotals): number | null {
  return totals.clicks === 0 ? null : totals.purchases / totals.clicks;
}
function cpm(totals: MetaWindowTotals): number | null {
  return totals.impressions === 0 ? null : (totals.spendMinorUnits * 1000) / totals.impressions;
}
function frequency(totals: MetaWindowTotals): number | null {
  return totals.reach === 0 ? null : totals.impressions / totals.reach;
}

export function computeTrend(
  current7d: MetaWindowTotals,
  previous7d: MetaWindowTotals,
): TrendMetrics {
  const currentSpendPerDay = current7d.spendMinorUnits / 7;
  const previousSpendPerDay = previous7d.spendMinorUnits / 7;

  return {
    roasChangePercent: percentChangeNullable(roas(current7d), roas(previous7d)),
    cpaChangePercent: percentChangeNullable(cpa(current7d), cpa(previous7d)),
    ctrChangePercent: percentChangeNullable(ctr(current7d), ctr(previous7d)),
    cvrChangePercent: percentChangeNullable(cvr(current7d), cvr(previous7d)),
    cpmChangePercent: percentChangeNullable(cpm(current7d), cpm(previous7d)),
    frequencyChangePercent: percentChangeNullable(frequency(current7d), frequency(previous7d)),
    spendVelocityChangePercent: percentChange(currentSpendPerDay, previousSpendPerDay),
    purchaseVolumeTrend: purchaseVolumeTrend(current7d.purchases, previous7d.purchases),
  };
}
