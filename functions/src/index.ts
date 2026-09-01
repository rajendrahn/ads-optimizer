// B1 — the Cloud Tasks HTTP target. This is deliberately the entire runtime footprint of
// `functions/`: parse the request body, hand it to the bundled sync framework, write the
// response. See functions/src/generated/syncBundle.d.ts for why this is a bundled import
// rather than a direct one, and services/ingest/sync/httpHandler.ts for the retry-semantics
// reasoning behind the status codes this function ends up returning (they come straight
// through from `handleSyncTaskDispatch`, untouched).
//
// B2–B8 do not need to touch this file to add real task handlers — those register into
// services/ingest/sync/registry.ts's default registry, which this already dispatches through.
// This file only changes if the framework itself needs a second entrypoint (e.g. a dedicated
// enqueue/controller endpoint, or per-task-type Cloud Tasks queues instead of one shared one).

import { setGlobalOptions } from "firebase-functions/v2/options";
import { onRequest } from "firebase-functions/v2/https";
import { handleSyncTaskDispatch, type TaskDispatchRequestBody } from "./generated/syncBundle";
import { handleShopifyWebhookDispatch } from "./generated/shopifyWebhookBundle";

// Region is NOT optional here. Without it, Cloud Functions v2 defaults to us-central1, while
// this project's Firestore database is in asia-south1 — a permanent choice (A0/SETUP.md: the
// region cannot be changed after creation). Every Firestore call these functions make would
// then cross regions, adding latency to each one and egress cost to a workload whose whole job
// is reading and writing Firestore. The Cloud Tasks queues (sync-tasks, recommendation-tasks)
// are in asia-south1 too, so the dispatch hop would cross back the other way.
//
// Caught on the first real deploy, which landed both functions in us-central1. If a previous
// deploy created them there, deploying this does NOT move them — it creates new ones alongside,
// and the us-central1 pair must be deleted explicitly. See scripts/deploy.ps1's notes.
setGlobalOptions({ region: "asia-south1" });

export const syncTaskDispatch = onRequest(async (req, res) => {
  const body = req.body as Partial<TaskDispatchRequestBody> | undefined;
  const result = await handleSyncTaskDispatch({
    taskType: body?.taskType ?? "",
    payload: body?.payload,
    taskId: body?.taskId,
  });
  res.status(result.status).json(result.body);
});

// B6 — the Shopify webhook HTTPS endpoint (§9.5, §25). Deliberately thin, same shape as
// syncTaskDispatch above: all real logic (HMAC verification, Cloud Tasks enqueue) lives in
// services/ingest/shopify/webhooks/receiver.ts, bundled the same way B1's sync framework is —
// see functions/src/generated/shopifyWebhookBundle.d.ts. `req.rawBody` is the Firebase
// Functions framework's own Buffer of the exact, unparsed request body, which is what HMAC
// verification must run against (`req.body` is already-parsed JSON and would not byte-for-byte
// match what Shopify signed). This function does no Firestore/Shopify work itself — it only
// verifies and enqueues, then returns — matching B6's "fast acknowledge, then process
// asynchronously via Cloud Tasks" deliverable.
export const shopifyWebhookReceive = onRequest(async (req, res) => {
  const result = await handleShopifyWebhookDispatch({
    rawBody: req.rawBody ?? Buffer.from(""),
    headers: {
      hmac: req.get("X-Shopify-Hmac-Sha256"),
      topic: req.get("X-Shopify-Topic"),
      webhookId: req.get("X-Shopify-Webhook-Id"),
    },
  });
  res.status(result.status).json(result.body);
});
