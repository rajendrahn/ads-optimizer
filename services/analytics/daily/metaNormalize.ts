// Pure MetaInsightsDaily -> MetaInsightsDailyNormalized mapping (§5, §12). No Firestore. Every
// field here is either a direct carry-through (attribution, funnel counts, impressions/clicks/
// reach/frequency — none of that changes between "native" and "normalized," only the day and
// currency framing do) or one of C1's two actual jobs: remap the day (mapReportingDay.ts) and
// normalize the currency (currency.ts). No metric is derived here — that's C2's job
// (IMPLEMENTATION_PLAN.md C1 "Out of scope: windowed aggregation and derived metrics").

import { makeMoney } from "@shared/canon/index.ts";
import type { MetaInsightsDaily, MetaInsightsDailyNormalized } from "@shared/schema/index.ts";
import { normalizeToReportingCurrency } from "./currency.ts";
import { mapNativeDayToReportingDay } from "./mapReportingDay.ts";

export interface NormalizeMetaInsightsDailyRowCtx {
  reportingTimezone: string;
  reportingCurrency: string;
  /** The Meta ad account's own configured timezone — see mapReportingDay.ts's module comment
   * for why this isn't stored per-row and what it defaults to when not supplied. */
  nativeTimezone: string;
  computedAt: Date;
}

export function normalizeMetaInsightsDailyRow(
  row: MetaInsightsDaily,
  ctx: NormalizeMetaInsightsDailyRowCtx,
): MetaInsightsDailyNormalized {
  const mapped = mapNativeDayToReportingDay(row.date, ctx.nativeTimezone, ctx.reportingTimezone);

  return {
    adId: row.adId,
    adsetId: row.adsetId,
    campaignId: row.campaignId,
    accountId: row.accountId,
    reportingDay: mapped.reportingDay,
    reportingTimezone: ctx.reportingTimezone,
    nativeDate: row.date,
    nativeTimezone: ctx.nativeTimezone,
    attribution: row.attribution, // §5.3 — carried through intact, never re-derived
    spend: normalizeToReportingCurrency(
      makeMoney(row.spendMinorUnits, row.currency),
      ctx.reportingCurrency,
    ),
    purchaseValue: normalizeToReportingCurrency(
      makeMoney(row.purchaseValueMinorUnits, row.currency),
      ctx.reportingCurrency,
    ),
    impressions: row.impressions,
    reach: row.reach,
    frequency: row.frequency,
    clicks: row.clicks,
    landingPageViews: row.landingPageViews,
    addToCart: row.addToCart,
    initiateCheckout: row.initiateCheckout,
    purchases: row.purchases,
    sourceUpdatedAt: row.sourceUpdatedAt,
    computedAt: ctx.computedAt,
  };
}
