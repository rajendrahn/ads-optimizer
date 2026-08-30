// Pure Meta insights row -> Firestore normalization (§5.3, §7.2, §9.5). No Firestore, no
// network. Out of scope per this step's spec: "deriving any metric" — every field here is a
// direct rename/parse of what Meta returned, nothing computed (no ROAS, no CTR, nothing).

import {
  reportingDay,
  type AttributionProvenance,
  type MetaInsightsDaily,
} from "@shared/schema/index.ts";
import { parseDecimalToMinorUnits } from "@shared/canon/index.ts";
import { findActionValue, type RawInsightsRow } from "./reportRequest.ts";

export interface NormalizeInsightsRowCtx {
  accountId: string;
  currency: string;
  /** Pinned at job-submission time — see shared/schema/meta.ts's module comment on
   * metaInsightsReportJobSchema for why this is the job's own stored value, not a fresh
   * `loadReportingCanon()` read. */
  attribution: AttributionProvenance;
  /** One timestamp shared by every row normalized in the same fetch — see
   * shared/firestore/versionGuard.ts's module comment: for metaInsightsDaily this is our own
   * fetch/reconciliation-run timestamp, not a Meta-provided field. */
  fetchedAt: Date;
}

function parseNonNegativeInt(value: string | undefined): number {
  if (value === undefined) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseNullableNonNegativeInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseNullableFloat(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Throws when a row is missing a field this schema requires non-nullable (ad_id/adset_id/
 * campaign_id/date_start) — Meta returning a row this malformed at level=ad would indicate a
 * request shape bug worth surfacing loudly, not silently dropping a row. */
export function normalizeInsightsRow(
  row: RawInsightsRow,
  ctx: NormalizeInsightsRowCtx,
): MetaInsightsDaily {
  if (!row.ad_id || !row.adset_id || !row.campaign_id || !row.date_start) {
    throw new Error(
      `normalizeInsightsRow: row missing a required identifying field (ad_id/adset_id/campaign_id/date_start): ${JSON.stringify(row)}`,
    );
  }

  const purchaseActionType = ctx.attribution.purchaseActionType;

  return {
    adId: row.ad_id,
    adsetId: row.adset_id,
    campaignId: row.campaign_id,
    accountId: ctx.accountId,
    // Native Meta-account-timezone day, stored verbatim — see metaInsightsDailySchema's own
    // comment ("C1 remaps to canon"). Meta already returns exactly YYYY-MM-DD; validated here
    // (rather than cast) so a malformed date_start fails loudly at normalize time.
    date: reportingDay.parse(row.date_start),
    attribution: ctx.attribution,
    spendMinorUnits: parseDecimalToMinorUnits(row.spend ?? "0", ctx.currency).amountMinorUnits,
    currency: ctx.currency,
    impressions: parseNonNegativeInt(row.impressions),
    reach: parseNullableNonNegativeInt(row.reach),
    frequency: parseNullableFloat(row.frequency),
    clicks: parseNonNegativeInt(row.clicks),
    landingPageViews: parseNonNegativeInt(findActionValue(row.actions, "landing_page_view")),
    addToCart: parseNonNegativeInt(findActionValue(row.actions, "add_to_cart")),
    initiateCheckout: parseNonNegativeInt(findActionValue(row.actions, "initiate_checkout")),
    purchases: parseNonNegativeInt(findActionValue(row.actions, purchaseActionType)),
    purchaseValueMinorUnits: parseDecimalToMinorUnits(
      findActionValue(row.action_values, purchaseActionType),
      ctx.currency,
    ).amountMinorUnits,
    sourceUpdatedAt: ctx.fetchedAt,
    fetchedAt: ctx.fetchedAt,
  };
}
