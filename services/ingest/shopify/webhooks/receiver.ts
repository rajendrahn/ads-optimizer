// The Shopify webhook HTTPS endpoint's framework-agnostic core (§9.5, §25; B6's deliverable
// list: "HTTPS endpoint with HMAC signature verification" + "fast acknowledge, then process
// asynchronously via Cloud Tasks"). Mirrors services/ingest/sync/httpHandler.ts's own shape
// deliberately: a plain request-in/response-out function with no Express/Cloud Functions
// dependency, so retry/signature semantics are fully unit-testable without deploying anything —
// runtime.ts wires this to real Secret Manager + a real Cloud Tasks queue, functions/src/
// index.ts wraps it in a few lines of `onRequest` glue.
//
// **This function does no Firestore work and calls no Shopify/Meta API at all** — that is what
// makes it "fast acknowledge, then process asynchronously" rather than a description of intent.
// Its only two possible outcomes are: verify the signature and enqueue a Cloud Task (200), or
// refuse (401/400) without enqueuing anything. The actual order/refund normalization and
// version-guarded Firestore writes happen later, in a completely separate HTTP round trip, when
// Cloud Tasks calls back into services/ingest/sync/httpHandler.ts's existing dispatch target and
// runs processTask.ts's SHOPIFY_PROCESS_WEBHOOK handler.

import type { TaskQueueClient } from "../../sync/taskQueue.ts";
import { verifyShopifyWebhookHmac } from "./verify.ts";

export interface ShopifyWebhookHeaders {
  /** X-Shopify-Hmac-Sha256 */
  hmac?: string | null;
  /** X-Shopify-Topic, e.g. "orders/create" */
  topic?: string | null;
  /** X-Shopify-Webhook-Id — Shopify's own delivery id. Threaded through as the Cloud Tasks task
   * name AND runSyncTask's idempotency key (taskId) — see processTask.ts's module comment. */
  webhookId?: string | null;
}

export interface ShopifyWebhookRequest {
  /** The exact raw request body bytes, before any JSON parsing — HMAC verification MUST run
   * against these, never a re-serialized object (see verify.ts's module comment). */
  rawBody: string | Buffer;
  headers: ShopifyWebhookHeaders;
}

export interface ShopifyWebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface HandleShopifyWebhookDeps {
  /** The resolved `shopify-webhook-secret` (SETUP.md §3: the custom app's own API secret key). */
  webhookSecret: string;
  taskQueue: TaskQueueClient;
}

export async function handleShopifyWebhookRequest(
  req: ShopifyWebhookRequest,
  deps: HandleShopifyWebhookDeps,
): Promise<ShopifyWebhookResponse> {
  if (!verifyShopifyWebhookHmac(req.rawBody, req.headers.hmac, deps.webhookSecret)) {
    // Refuse before touching anything else — no enqueue, no parse. An invalid signature gets
    // no more information back than "invalid signature" (no echo of what was expected).
    return { status: 401, body: { error: "invalid webhook signature" } };
  }

  if (!req.headers.topic || !req.headers.webhookId) {
    return { status: 400, body: { error: "missing X-Shopify-Topic/X-Shopify-Webhook-Id header" } };
  }

  let body: unknown;
  try {
    const bodyText = typeof req.rawBody === "string" ? req.rawBody : req.rawBody.toString("utf8");
    body = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { error: "invalid JSON body" } };
  }

  await deps.taskQueue.enqueue({
    taskType: "SHOPIFY_PROCESS_WEBHOOK",
    payload: { topic: req.headers.topic, webhookId: req.headers.webhookId, body },
    taskId: req.headers.webhookId,
  });

  return { status: 200, body: { received: true } };
}
