// NORMALIZE_SHOPIFY_DAILY — C1's own task type (same category of addition as
// NORMALIZE_META_INSIGHTS_DAILY, see that file's module comment): re-expresses every
// already-synced `shopifyOrders`/`shopifyRefunds` row (B5) onto the canon reporting day and
// currency (§5), one normalized row per source row, and marks every reporting day's coverage
// against B5's own `syncState/shopify_orders.knownGaps` — read here, never re-derived (this
// step's own brief: "B5 recorded it in syncState ... read it, do not re-derive it").
//
// `runSource: "internal"` / `syncStateTarget: null` — same reasoning as the Meta task: no live
// Shopify call, no watermark of its own, a Firestore-to-Firestore re-derivation from data B5
// already synced. Full recompute of the whole `shopifyOrders`/`shopifyRefunds` collections every
// run — this account's real order volume (B5: ~10K CSV-backfilled orders, growing via ongoing
// sync) is still comfortably within "a few thousand small reads and writes" territory (§10.1).
//
// Coverage rows are written for every calendar day from the earliest normalized order/refund (or
// the earliest known gap, if that's earlier — a gap with zero orders inside it still needs a
// coverage row) through TODAY in the reporting timezone — not just through the latest observed
// order — specifically because B5's gap widens by one day on every run nothing closes it
// (gap.ts's own module comment). Recomputing through today on every run is what keeps this table
// from silently understating the hole the same way a cached gap value would.

import { getDb } from "@shared/firestore/index.ts";
import {
  COLLECTIONS,
  createRepository,
  shopifyRefundNormalizedKey,
  syncStateKey,
  upsertWithVersionGuard,
} from "@shared/firestore/index.ts";
import { loadReportingCanon, toReportingDay } from "@shared/canon/index.ts";
import {
  shopifyDailyCoverageSchema,
  shopifyOrderNormalizedSchema,
  shopifyOrderSchema,
  shopifyRefundNormalizedSchema,
  shopifyRefundSchema,
  type ReportingDay,
  type ShopifyOrder,
  type ShopifyRefund,
} from "@shared/schema/index.ts";
import { mapWithConcurrency } from "@services/ingest/meta/insights/index.ts";
import { createFirestoreSyncStore } from "@services/ingest/sync/store.ts";
import type { TaskRegistration } from "@services/ingest/sync/registry.ts";
import type { TaskHandler } from "@services/ingest/sync/taskWrapper.ts";
import { computeShopifyDailyCoverage } from "./coverage.ts";
import { normalizeShopifyOrder, normalizeShopifyRefund } from "./shopifyNormalize.ts";

export interface NormalizeShopifyDailyPayload {
  writeConcurrency?: number;
}

function parsePayload(raw: unknown): NormalizeShopifyDailyPayload {
  if (typeof raw !== "object" || raw === null) return {};
  return raw as NormalizeShopifyDailyPayload;
}

function bumpCount(map: Map<ReportingDay, number>, day: ReportingDay): void {
  map.set(day, (map.get(day) ?? 0) + 1);
}

function minDay(a: ReportingDay | null, b: ReportingDay): ReportingDay {
  if (a === null) return b;
  return a < b ? a : b;
}

export const normalizeShopifyDailyHandler: TaskHandler = async (ctx) => {
  const payload = parsePayload(ctx.payload);
  const canon = await loadReportingCanon();
  const db = getDb();
  const writeConcurrency = payload.writeConcurrency ?? 20;
  const computedAt = new Date();

  const syncStore = createFirestoreSyncStore(db);
  const state = await syncStore.getSyncState(syncStateKey("shopify", "orders"));
  const knownGaps = state?.knownGaps ?? [];

  const ordersRepo = createRepository<ShopifyOrder>(
    db,
    COLLECTIONS.shopifyOrders,
    shopifyOrderSchema,
  );
  const refundsRepo = createRepository<ShopifyRefund>(
    db,
    COLLECTIONS.shopifyRefunds,
    shopifyRefundSchema,
  );

  const [orders, refunds] = await Promise.all([
    ordersRepo.query((ref) => ref),
    refundsRepo.query((ref) => ref),
  ]);

  const ordersObservedByDay = new Map<ReportingDay, number>();
  const refundsObservedByDay = new Map<ReportingDay, number>();
  let earliestDay: ReportingDay | null = null;

  let ordersWritten = 0;
  let ordersRejected = 0;
  await mapWithConcurrency(orders, writeConcurrency, async (order) => {
    const normalized = normalizeShopifyOrder(order, {
      reportingTimezone: canon.reportingTimezone,
      reportingCurrency: canon.reportingCurrency,
      computedAt,
    });
    bumpCount(ordersObservedByDay, normalized.reportingDay);
    earliestDay = minDay(earliestDay, normalized.reportingDay);
    const outcome = await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.shopifyOrdersNormalized,
      docId: normalized.orderId,
      incoming: normalized,
      schema: shopifyOrderNormalizedSchema,
      onRejected: ctx.recordVersionGuardRejection,
    });
    if (outcome.action === "written") ordersWritten++;
    else ordersRejected++;
  });

  let refundsWritten = 0;
  let refundsRejected = 0;
  await mapWithConcurrency(refunds, writeConcurrency, async (refund) => {
    const normalized = normalizeShopifyRefund(refund, {
      reportingTimezone: canon.reportingTimezone,
      reportingCurrency: canon.reportingCurrency,
      computedAt,
    });
    bumpCount(refundsObservedByDay, normalized.reportingDay);
    earliestDay = minDay(earliestDay, normalized.reportingDay);
    const docId = shopifyRefundNormalizedKey(normalized.orderId, normalized.refundId);
    const outcome = await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.shopifyRefundsNormalized,
      docId,
      incoming: normalized,
      schema: shopifyRefundNormalizedSchema,
      onRejected: ctx.recordVersionGuardRejection,
    });
    if (outcome.action === "written") refundsWritten++;
    else refundsRejected++;
  });

  const today = toReportingDay(computedAt, canon.reportingTimezone);
  let fromDay = earliestDay ?? today;
  for (const gap of knownGaps) fromDay = minDay(fromDay, gap.startDate);

  const coverageRows = computeShopifyDailyCoverage({
    reportingTimezone: canon.reportingTimezone,
    accountId: canon.accountId,
    fromDay,
    toDay: today,
    ordersObservedByDay,
    refundsObservedByDay,
    knownGaps,
    computedAt,
  });

  let coverageWritten = 0;
  await mapWithConcurrency(coverageRows, writeConcurrency, async (row) => {
    const outcome = await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.shopifyDailyCoverage,
      docId: row.reportingDay,
      incoming: row,
      schema: shopifyDailyCoverageSchema,
      onRejected: ctx.recordVersionGuardRejection,
    });
    if (outcome.action === "written") coverageWritten++;
  });

  return {
    newRowCount: ordersWritten + refundsWritten,
    summary: {
      ordersRead: orders.length,
      ordersWritten,
      ordersRejected,
      refundsRead: refunds.length,
      refundsWritten,
      refundsRejected,
      coverageDaysWritten: coverageWritten,
      coverageRange: { fromDay, toDay: today },
      knownGapsCount: knownGaps.length,
    },
  };
};

export const normalizeShopifyDailyRegistration: TaskRegistration = {
  taskType: "NORMALIZE_SHOPIFY_DAILY",
  runSource: "internal",
  syncStateTarget: null,
  handler: normalizeShopifyDailyHandler,
};
