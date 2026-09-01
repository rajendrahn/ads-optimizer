// Point-in-time Shopify order reconstruction — reuses B5's own pure CSV parser/normalizer
// (`parseMatrixifyCsv`, `normalizeMatrixifyOrderGroup`) and C1's own pure day/currency
// normalizer (`normalizeShopifyOrder`, `normalizeShopifyRefund`) UNCHANGED, same discipline as
// reconstructMeta.ts.
//
// Deliberately scoped to the "orders_csv_import" archive resource only (the Matrixify historical
// backfill, matrixifyImport.ts) — NOT the incremental GraphQL "orders_sync" resource
// (ordersSync.ts). This is a real, documented scope cut, not an oversight: this account's deep
// order HISTORY (the only history a multi-month backtest can replay against) came from the CSV
// backfill; the GraphQL path is a 60-day-bounded incremental sync (ordersSync.ts's own module
// comment) that exists to keep recent orders current, not to hold years of replayable history.
// Reconstructing the GraphQL page's nested-node shape would add real parsing surface for a
// resource that, for backtest purposes, is a strict subset of what the CSV path already covers
// over any window old enough to be worth replaying. A future iteration wanting to replay the
// most recent ~60 days at CSV-import granularity should add a sibling
// `reconstructShopifyOrdersFromGraphqlAsOf`, reusing `normalizeGraphqlOrder` the same way this
// file reuses `normalizeMatrixifyOrderGroup` — flagged here rather than silently assumed covered.
//
// Also out of scope, deliberately: B7's UTM/ad-id attribution join. The account's real
// Shopify-attributed coverage is ~0.02% (B7) — not a usable per-entity success measure (see this
// step's report) — so this reconstruction never attempts to resolve `resolvedAdId`/
// `resolvedCampaignId` and every order's `isNewCustomer` stays `null` (B5's own newVsRepeat.ts
// recompute pass is also not replayed). The backtest instead uses reconstructed Shopify orders
// ONLY for the account-level blended MER context (§6.3) — a total ÷ total figure that needs no
// per-order attribution at all.

import { parseMatrixifyCsv } from "@services/ingest/shopify/orders/csvParser.ts";
import { normalizeMatrixifyOrderGroup } from "@services/ingest/shopify/orders/csvNormalize.ts";
import {
  normalizeShopifyOrder,
  normalizeShopifyRefund,
} from "@services/analytics/daily/shopifyNormalize.ts";
import { computeShopifyDailyCoverage } from "@services/analytics/daily/coverage.ts";
import type {
  ReportingDay,
  ShopifyDailyCoverage,
  ShopifyOrderNormalized,
  ShopifyRefundNormalized,
  SyncStateKnownGap,
} from "@shared/schema/index.ts";
import type { PointInTimeArchiveReader } from "./pointInTimeArchive.ts";

export interface ReconstructShopifyCtx {
  reportingTimezone: string;
  reportingCurrency: string;
  accountId: string;
  /** B5's own recorded `knownGaps` — see coverage.ts's own module comment: this reconstruction
   * never re-derives the gap boundary, only consumes what's supplied (matching C1's own
   * discipline of reading, never recomputing, B5's gap). Pass the account's real recorded gap
   * for a genuine replay; a caller proving the mechanism against synthetic history supplies its
   * own synthetic gap (or `[]` for none). */
  knownGaps: readonly SyncStateKnownGap[];
  /** Coverage rows are computed for every day in [fromDay, toDay] — see coverage.ts. A caller
   * should pass a range covering the full window the backtest needs (decision window + horizon),
   * not just the days orders happen to exist for — a day with zero orders still needs a coverage
   * verdict. */
  fromDay: ReportingDay;
  toDay: ReportingDay;
}

export interface ReconstructedShopifyState {
  orders: ShopifyOrderNormalized[];
  refunds: ShopifyRefundNormalized[];
  coverageByDay: ReadonlyMap<ReportingDay, ShopifyDailyCoverage>;
}

export async function reconstructShopifyNormalizedAsOf(
  reader: PointInTimeArchiveReader,
  ctx: ReconstructShopifyCtx,
): Promise<ReconstructedShopifyState> {
  const records = await reader.readArchivedPayloads("shopify", "orders_csv_import");
  const computedAt = reader.asOfInstant;

  const orders: ShopifyOrderNormalized[] = [];
  const refunds: ShopifyRefundNormalized[] = [];
  const ordersObservedByDay = new Map<ReportingDay, number>();
  const refundsObservedByDay = new Map<ReportingDay, number>();

  for (const record of records) {
    const syncedAt = reader.runFinishedAt(record.runId) ?? reader.asOfInstant;
    const csvText = record.payload as string;
    let parsed;
    try {
      parsed = parseMatrixifyCsv(csvText);
    } catch (err) {
      console.warn(
        `[backtest] reconstructShopifyNormalizedAsOf: skipping unparseable CSV in ${record.path}`,
        err,
      );
      continue;
    }
    for (const group of parsed.orders) {
      const { order, refunds: refundGroup } = normalizeMatrixifyOrderGroup(group, { syncedAt });
      const normalizedOrder = normalizeShopifyOrder(order, {
        reportingTimezone: ctx.reportingTimezone,
        reportingCurrency: ctx.reportingCurrency,
        computedAt,
      });
      orders.push(normalizedOrder);
      ordersObservedByDay.set(
        normalizedOrder.reportingDay,
        (ordersObservedByDay.get(normalizedOrder.reportingDay) ?? 0) + 1,
      );
      for (const refund of refundGroup) {
        const normalizedRefund = normalizeShopifyRefund(refund, {
          reportingTimezone: ctx.reportingTimezone,
          reportingCurrency: ctx.reportingCurrency,
          computedAt,
        });
        refunds.push(normalizedRefund);
        refundsObservedByDay.set(
          normalizedRefund.reportingDay,
          (refundsObservedByDay.get(normalizedRefund.reportingDay) ?? 0) + 1,
        );
      }
    }
  }

  const coverageRows = computeShopifyDailyCoverage({
    reportingTimezone: ctx.reportingTimezone,
    accountId: ctx.accountId,
    fromDay: ctx.fromDay,
    toDay: ctx.toDay,
    ordersObservedByDay,
    refundsObservedByDay,
    knownGaps: ctx.knownGaps,
    computedAt,
  });
  const coverageByDay = new Map(coverageRows.map((r) => [r.reportingDay, r]));

  return { orders, refunds, coverageByDay };
}
