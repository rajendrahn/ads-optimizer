// SHOPIFY_IMPORT_ORDERS_CSV — the Matrixify CSV historical backfill (§9.1, §7.2). Reads a
// Matrixify export from the restricted PII bucket, row-groups it, normalizes it, and writes
// orders/lines/refunds through the A2 version guard exactly like every other Shopify write.
//
// **Safely re-runnable, and accepts more than one export file** — IMPLEMENTATION_PLAN.md B5's
// orchestrator brief: the real export turned out to be a partial snapshot (~10k of ~22.6k
// orders, capped by the exporting tool's own plan/row limit — see csvParser.ts's
// `isJunkMatrixifyRow` comment for the literal trailer row that proves this), and further
// exports will arrive later. Re-running against the SAME file is a no-op beyond the first run
// (every order's `sourceUpdatedAt` is unchanged, so every write is an accepted equal-version
// write — see shared/firestore/versionGuard.ts). Running against a DIFFERENT, larger file
// merges in cleanly: new orders write for the first time, previously-seen orders whose
// `Updated At` has moved forward overwrite correctly, and orders whose `Updated At` in the new
// file is somehow *older* (shouldn't happen for a fresher export, but the guard doesn't trust
// that) are rejected and logged rather than silently regressing data.
//
// `payload.objectKey` selects which object in the PII bucket to import; defaults to this
// account's original export. This is what makes "accepts multiple export files" concrete: a
// later, larger export just needs a task invocation naming its own object key.

import { getDb } from "@shared/firestore/index.ts";
import {
  COLLECTIONS,
  shopifyOrderLineKey,
  shopifyRefundKey,
  upsertWithVersionGuard,
} from "@shared/firestore/index.ts";
import { loadReportingCanon, toReportingDay } from "@shared/canon/index.ts";
import {
  shopifyOrderLineSchema,
  shopifyOrderSchema,
  shopifyRefundSchema,
} from "@shared/schema/index.ts";
import type { ReportingDay } from "@shared/schema/index.ts";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import { parseMatrixifyCsv } from "./csvParser.ts";
import { normalizeMatrixifyOrderGroup } from "./csvNormalize.ts";
import {
  createDefaultMatrixifyCsvSource,
  SHOPIFY_MATRIXIFY_DEFAULT_OBJECT_KEY,
  type MatrixifyCsvSource,
} from "./csvSource.ts";
import { computeShopifyOrdersGap } from "./gap.ts";
import { recomputeAndPersistNewVsRepeat } from "./newVsRepeat.ts";

export interface MatrixifyImportPayload {
  /** Which object in the PII bucket to import. Defaults to this account's original export —
   * see module comment on re-running against a later, different file. */
  objectKey?: string;
}

function parsePayload(raw: unknown): MatrixifyImportPayload {
  if (typeof raw !== "object" || raw === null) return {};
  const objectKey = (raw as { objectKey?: unknown }).objectKey;
  return { objectKey: typeof objectKey === "string" ? objectKey : undefined };
}

/**
 * Factory (not a plain handler constant) so tests can inject a fake `MatrixifyCsvSource`
 * without touching the real, restricted PII bucket — see csvSource.ts's module comment. The
 * real `MatrixifyCsvSource` is constructed lazily, inside the returned handler, never at import
 * time, so importing this module has no side effect (no `Storage` client, no credential
 * resolution) until a task actually runs.
 */
export function createMatrixifyImportHandler(csvSourceOverride?: MatrixifyCsvSource): TaskHandler {
  return async (ctx) => {
    const csvSource = csvSourceOverride ?? createDefaultMatrixifyCsvSource();
    const payload = parsePayload(ctx.payload);
    const objectKey = payload.objectKey ?? SHOPIFY_MATRIXIFY_DEFAULT_OBJECT_KEY;

    const db = getDb();
    const canon = await loadReportingCanon();
    const today = toReportingDay(new Date(), canon.reportingTimezone);

    const csvText = await csvSource.read(objectKey);
    await ctx.archiver.archive({
      source: "shopify",
      day: today,
      resource: "orders_csv_import",
      runId: ctx.runId,
      payload: csvText,
    });

    const { orders: groups, skippedJunkRowCount } = parseMatrixifyCsv(csvText);
    const syncedAt = new Date();

    let ordersWritten = 0;
    let linesWritten = 0;
    let refundsWritten = 0;
    let versionRejections = 0;
    let maxCreatedDay: ReportingDay | null = null;
    let maxUpdatedDay: ReportingDay | null = null;

    for (const group of groups) {
      const { order, lines, refunds } = normalizeMatrixifyOrderGroup(group, { syncedAt });

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

      const createdDay = toReportingDay(order.createdAt, canon.reportingTimezone);
      if (!maxCreatedDay || createdDay > maxCreatedDay) maxCreatedDay = createdDay;
      const updatedDay = toReportingDay(order.sourceUpdatedAt, canon.reportingTimezone);
      if (!maxUpdatedDay || updatedDay > maxUpdatedDay) maxUpdatedDay = updatedDay;
    }

    const newVsRepeat = await recomputeAndPersistNewVsRepeat(db);

    // Note: this always sets backfillCoverageThroughDate to what THIS run's file reaches,
    // rather than max()-ing with whatever was already stored. Safe under the expected usage
    // (successive exports are supersets reaching further, per module comment) but would
    // regress the stored value if fed an older/smaller file out of order — a known, accepted
    // limitation rather than a guarded case, since the handler has no read access to the prior
    // syncState value (see IMPLEMENTATION_PLAN.md B5 notes).
    return {
      newWatermarkDate: maxUpdatedDay ?? undefined,
      newRowCount: ordersWritten,
      backfillCoverageThroughDate: maxCreatedDay,
      knownGaps: computeShopifyOrdersGap({ backfillCoverageThroughDate: maxCreatedDay, today }),
      summary: {
        objectKey,
        ordersInFile: groups.length,
        ordersWritten,
        linesWritten,
        refundsWritten,
        versionRejections,
        skippedJunkRowCount,
        newVsRepeat,
      },
    };
  };
}

export const matrixifyImportHandler: TaskHandler = createMatrixifyImportHandler();

export const matrixifyImportRegistration: TaskRegistration = {
  taskType: "SHOPIFY_IMPORT_ORDERS_CSV",
  runSource: "shopify",
  syncStateTarget: { source: "shopify", resource: "orders" },
  handler: matrixifyImportHandler,
};
