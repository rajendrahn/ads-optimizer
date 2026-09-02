// SHOPIFY_SYNC_ORDERS — incremental order sync via `updated_at` watermark over plain paginated
// GraphQL (§7.2, §9.3): "no Bulk Operations needed — that machinery existed only for the
// historical backfill this replaces."
//
// Shares `syncState/shopify_orders` with SHOPIFY_IMPORT_ORDERS_CSV (see matrixifyImport.ts):
// both advance the same `lastDataDate` watermark (the reporting day of the latest order
// `updated_at` either has written), and this task reads (but never itself sets)
// `backfillCoverageThroughDate` to keep `knownGaps` current on every run — see gap.ts.
//
// Watermark handling follows the pattern the concurrent B3 insights task already established
// (services/ingest/meta/insights/insightsSync.ts): read `syncState` directly via its own
// `SyncStore`, rather than `TaskContext` exposing it — `runSyncTask` (taskWrapper.ts) computes
// `watermarkBefore` for its own bookkeeping but doesn't thread it onto `ctx`, so a handler that
// needs it reads the same document itself. Unlike Meta's reconciliation window
// (`computeReconciliationWindow`, which refuses to run with no watermark — "reconciliation
// re-fetches history, it does not create it"), a null watermark here is NOT an error: Shopify's
// own `read_orders` scope already bounds a lower-bound-less fetch to roughly the last 60 days
// (verified live — graphqlFetch.ts), so "no watermark yet" just means "fetch everything
// Shopify will show me," which is the correct first-run behaviour.

import { getDb } from "@shared/firestore/index.ts";
import {
  COLLECTIONS,
  shopifyOrderLineKey,
  shopifyRefundKey,
  syncStateKey,
  upsertWithVersionGuard,
} from "@shared/firestore/index.ts";
import { loadReportingCanon, reportingDayToUtcRange, toReportingDay } from "@shared/canon/index.ts";
import {
  shopifyOrderLineSchema,
  shopifyOrderSchema,
  shopifyRefundSchema,
} from "@shared/schema/index.ts";
import type { ReportingDay } from "@shared/schema/index.ts";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import { createFirestoreSyncStore } from "../../sync/store.ts";
import { fetchAllUpdatedOrders } from "./graphqlFetch.ts";
import { normalizeGraphqlOrder } from "./graphqlNormalize.ts";
import { computeShopifyOrdersGap } from "./gap.ts";
import { recomputeAndPersistNewVsRepeat } from "./newVsRepeat.ts";

export interface ShopifySyncOrdersPayload {
  /** Overrides the GraphQL page size (line-item/refund fan-out per order makes this
   * meaningfully more expensive than a flat resource page — default kept conservative in
   * graphqlFetch.ts). */
  pageSize?: number;
  /** Reporting day (YYYY-MM-DD) to start from, overriding the stored watermark. ONLY for
   * deliberately closing a `syncState.knownGaps` hole — an incremental run starts at the
   * watermark, which sits after the gap, so it can never fill one. Omit for normal runs. */
  since?: string;
}

function parsePayload(raw: unknown): ShopifySyncOrdersPayload {
  if (typeof raw !== "object" || raw === null) return {};
  const pageSize = (raw as { pageSize?: unknown }).pageSize;
  const since = (raw as { since?: unknown }).since;
  return {
    pageSize: typeof pageSize === "number" ? pageSize : undefined,
    since: typeof since === "string" ? since : undefined,
  };
}

export const shopifySyncOrdersHandler: TaskHandler = async (ctx) => {
  const payload = parsePayload(ctx.payload);
  const db = getDb();
  const canon = await loadReportingCanon();
  const today = toReportingDay(new Date(), canon.reportingTimezone);
  const stateKey = syncStateKey("shopify", "orders");
  const syncStore = createFirestoreSyncStore(db);
  const priorState = await syncStore.getSyncState(stateKey);

  // An explicit `since` overrides the watermark, for closing a KNOWN historical gap. Normal
  // incremental runs must never pass it: starting before the watermark re-fetches data already
  // held, and the whole point of the watermark is not doing that.
  //
  // This exists because `syncState.knownGaps` records a real hole ([2025-12-14, 2026-07-05) on
  // this account) that an incremental sync structurally cannot fill — it starts at the
  // watermark, which sits AFTER the gap, so the gap would persist forever no matter how often
  // the task ran. Closing it needs a deliberate, operator-chosen start date. Safe to re-run:
  // every write goes through A2's version guard, so re-fetching an order already held cannot
  // move it backwards.
  const sinceOverride = payload.since
    ? reportingDayToUtcRange(payload.since, canon.reportingTimezone).startUtc
    : null;
  const sinceInstant =
    sinceOverride ??
    (priorState?.lastDataDate
      ? reportingDayToUtcRange(priorState.lastDataDate, canon.reportingTimezone).startUtc
      : new Date(0)); // no watermark yet — Shopify's own scope bounds this, see module comment

  const client = await ctx.getShopifyClient();

  let ordersWritten = 0;
  let linesWritten = 0;
  let refundsWritten = 0;
  let versionRejections = 0;
  let maxUpdatedAt: Date | null = null;

  await fetchAllUpdatedOrders(
    client,
    sinceInstant,
    async (page) => {
      await ctx.archiver.archive({
        source: "shopify",
        day: today,
        resource: "orders_sync",
        runId: ctx.runId,
        payload: page.raw,
      });

      const syncedAt = new Date();
      for (const node of page.orders) {
        const { order, lines, refunds } = normalizeGraphqlOrder(node, { syncedAt });

        const orderOutcome = await upsertWithVersionGuard({
          db,
          collectionName: COLLECTIONS.shopifyOrders,
          docId: order.orderId,
          incoming: order,
          schema: shopifyOrderSchema,
          onRejected: ctx.recordVersionGuardRejection,
        });
        if (orderOutcome.action === "written") ordersWritten++;
        else versionRejections++;

        for (const line of lines) {
          const outcome = await upsertWithVersionGuard({
            db,
            collectionName: COLLECTIONS.shopifyOrderLines,
            docId: shopifyOrderLineKey(order.orderId, line.lineItemId),
            incoming: line,
            schema: shopifyOrderLineSchema,
            onRejected: ctx.recordVersionGuardRejection,
          });
          if (outcome.action === "written") linesWritten++;
          else versionRejections++;
        }

        for (const refund of refunds) {
          const outcome = await upsertWithVersionGuard({
            db,
            collectionName: COLLECTIONS.shopifyRefunds,
            docId: shopifyRefundKey(order.orderId, refund.refundId),
            incoming: refund,
            schema: shopifyRefundSchema,
            onRejected: ctx.recordVersionGuardRejection,
          });
          if (outcome.action === "written") refundsWritten++;
          else versionRejections++;
        }

        if (!maxUpdatedAt || order.sourceUpdatedAt > maxUpdatedAt) {
          maxUpdatedAt = order.sourceUpdatedAt;
        }
      }
    },
    { pageSize: payload.pageSize },
  );

  const newVsRepeat = await recomputeAndPersistNewVsRepeat(db);

  const newWatermarkDate: ReportingDay | undefined = maxUpdatedAt
    ? toReportingDay(maxUpdatedAt, canon.reportingTimezone)
    : (priorState?.lastDataDate ?? undefined);

  return {
    newWatermarkDate,
    newRowCount: ordersWritten,
    // backfillCoverageThroughDate omitted — this task never sets it, only reads it (see
    // TaskHandlerResult's carry-forward-if-omitted contract). knownGaps IS recomputed every
    // run, using whatever backfillCoverageThroughDate is currently stored, so the gap stays
    // accurate as "today" advances even on a run that finds nothing new.
    knownGaps: computeShopifyOrdersGap({
      backfillCoverageThroughDate: priorState?.backfillCoverageThroughDate ?? null,
      today,
    }),
    summary: { ordersWritten, linesWritten, refundsWritten, versionRejections, newVsRepeat },
  };
};

export const shopifySyncOrdersRegistration: TaskRegistration = {
  taskType: "SHOPIFY_SYNC_ORDERS",
  runSource: "shopify",
  syncStateTarget: { source: "shopify", resource: "orders" },
  handler: shopifySyncOrdersHandler,
};
