// SHOPIFY_PROCESS_WEBHOOK — the async half of B6's webhook pipeline (§9.5, §25: "Shopify
// webhooks: Real time"). This task type is never invoked directly by Shopify: receiver.ts
// verifies the HMAC and enqueues this task via Cloud Tasks (§10.2's controller), which then
// calls back into the SAME Cloud Tasks HTTP target B1 already built
// (services/ingest/sync/httpHandler.ts) — no second dispatch endpoint needed, and this is what
// "fast acknowledge, then process asynchronously via Cloud Tasks" means concretely: the HTTPS
// endpoint Shopify calls (receiver.ts) does no Firestore work at all, only verify + enqueue.
//
// `runSyncTask` (taskWrapper.ts) supplies this task type's idempotency for free: the webhook's
// own `X-Shopify-Webhook-Id` is threaded through as both the Cloud Tasks task name (taskQueue.ts)
// AND `runSyncTask`'s `taskId` (== the syncRuns doc id, per B1's ID scheme), so a replayed
// webhook — Shopify's own documented at-least-once delivery, a merchant-triggered resend, or a
// Cloud Tasks-level retry — short-circuits to SKIPPED_ALREADY_SUCCEEDED before this handler runs
// a second time. Nothing in this file implements idempotency itself; it's inherited.
//
// `syncStateTarget` is null — a single webhook delivery has no watermark of its own to advance.
// SHOPIFY_SYNC_ORDERS already owns `syncState/shopify_orders`'s `lastDataDate` via its own
// hourly/on-demand incremental sync (§25 lists "Shopify webhooks" and "Shopify reconciliation"
// as two distinct schedule rows on purpose — this task is the former, ordersSync.ts is the
// latter). Every write below still goes through `upsertWithVersionGuard` exactly like every
// other Shopify write (§9.5) — this task type is the scenario that guard exists for: "a refund
// webhook can arrive before the order update it follows."

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
import { ApiError } from "../../http/errors.ts";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import {
  normalizeWebhookOrder,
  normalizeWebhookRefund,
  resolveRefundCurrency,
  type RawWebhookOrderPayload,
  type RawWebhookRefundPayload,
} from "./normalize.ts";

/** The four topics B6 subscribes to (subscriptions.ts) and the only ones this handler
 * recognizes — Web Pixel / customer events are explicitly deferred (§7.2), and no other Admin
 * topic is ever registered against the live store by this step. */
const ORDER_TOPICS = new Set(["orders/create", "orders/updated", "orders/cancelled"]);
const REFUND_TOPIC = "refunds/create";

/** What receiver.ts enqueues as a Cloud Task's `payload` — the already-HMAC-verified, already
 * JSON-parsed webhook body, plus the two headers this task needs (topic to route on, webhookId
 * only for the summary/logs — the real idempotency key is `runSyncTask`'s own `taskId`, not
 * anything read from this payload). */
export interface ShopifyWebhookTaskPayload {
  topic: string;
  webhookId: string;
  body: unknown;
}

function terminal(message: string): ApiError {
  // client_error / retryable:false — a malformed payload or an unrecognized topic will look
  // exactly the same on a retry; only `syncRuns` recording the failure is useful here, not
  // Cloud Tasks hammering it again. See httpHandler.ts's module comment for the general
  // retryable/terminal -> HTTP status mapping this feeds into.
  return new ApiError(message, { kind: "client_error", retryable: false });
}

function parseTaskPayload(raw: unknown): ShopifyWebhookTaskPayload {
  if (typeof raw !== "object" || raw === null) {
    throw terminal("SHOPIFY_PROCESS_WEBHOOK: payload is not an object");
  }
  const { topic, webhookId, body } = raw as Record<string, unknown>;
  if (typeof topic !== "string" || topic.length === 0) {
    throw terminal("SHOPIFY_PROCESS_WEBHOOK: payload.topic missing/invalid");
  }
  if (typeof webhookId !== "string" || webhookId.length === 0) {
    throw terminal("SHOPIFY_PROCESS_WEBHOOK: payload.webhookId missing/invalid");
  }
  return { topic, webhookId, body };
}

export const shopifyProcessWebhookHandler: TaskHandler = async (ctx) => {
  const payload = parseTaskPayload(ctx.payload);
  const db = getDb();
  const syncedAt = new Date();
  const canon = await loadReportingCanon();

  // §23 raw payload archive — same infra every other B-phase task uses, so a webhook delivery
  // is replayable/debuggable the same way a sync page is, even though it arrives one event at a
  // time rather than as a fetched page.
  await ctx.archiver.archive({
    source: "shopify",
    day: toReportingDay(syncedAt, canon.reportingTimezone),
    resource: "webhook",
    runId: ctx.runId,
    payload: { topic: payload.topic, webhookId: payload.webhookId, body: payload.body },
  });

  let ordersWritten = 0;
  let linesWritten = 0;
  let refundsWritten = 0;
  let versionRejections = 0;

  if (ORDER_TOPICS.has(payload.topic)) {
    const node = payload.body as RawWebhookOrderPayload;
    const { order, lines, refunds } = normalizeWebhookOrder(node, { syncedAt });

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
  } else if (payload.topic === REFUND_TOPIC) {
    const raw = payload.body as RawWebhookRefundPayload;
    const orderId = String(raw.order_id);
    const currency = resolveRefundCurrency(raw);
    if (!currency) {
      throw terminal(
        `SHOPIFY_PROCESS_WEBHOOK: refund ${String(raw.id)} on order ${orderId} has no ` +
          `resolvable currency (no successful transaction or refund line item money data)`,
      );
    }
    const refund = normalizeWebhookRefund(raw, orderId, currency, { syncedAt });

    const outcome = await upsertWithVersionGuard({
      db,
      collectionName: COLLECTIONS.shopifyRefunds,
      docId: shopifyRefundKey(orderId, refund.refundId),
      incoming: refund,
      schema: shopifyRefundSchema,
      onRejected: ctx.recordVersionGuardRejection,
    });
    if (outcome.action === "written") refundsWritten++;
    else versionRejections++;
  } else {
    // Reaching here means a topic slipped through some other path than subscriptions.ts's own
    // list (B6 never registers anything else against the live store) — terminal, since
    // retrying an unrecognized topic will never resolve it.
    throw terminal(`SHOPIFY_PROCESS_WEBHOOK: unrecognized topic "${payload.topic}"`);
  }

  return {
    newRowCount: ordersWritten + refundsWritten,
    summary: {
      topic: payload.topic,
      webhookId: payload.webhookId,
      ordersWritten,
      linesWritten,
      refundsWritten,
      versionRejections,
    },
  };
};

export const shopifyProcessWebhookRegistration: TaskRegistration = {
  taskType: "SHOPIFY_PROCESS_WEBHOOK",
  runSource: "shopify",
  syncStateTarget: null,
  handler: shopifyProcessWebhookHandler,
};
