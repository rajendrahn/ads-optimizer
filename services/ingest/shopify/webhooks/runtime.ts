// Production wiring for the Shopify webhook HTTPS endpoint — real Secret Manager, real Cloud
// Tasks queue client. Mirrors services/ingest/sync/runtime.ts's own shape and its "not exercised
// live" status: this step's safety constraints forbid creating a Cloud Tasks queue or deploying
// anything, so `createDefaultTaskQueueClient` (services/ingest/sync/taskQueue.ts, B1) is called
// here but never actually invoked against a real queue by this step's own tests — same as B1's
// own precedent for that function.
//
// `SYNC_TASK_DISPATCH_URL` is a genuine deploy-time unknown: it's the URL of the `syncTaskDispatch`
// Cloud Function B1 already built, which does not exist until that function is deployed (see
// IMPLEMENTATION_PLAN.md B1's "what real cloud provisioning is still needed" list — nothing in
// this repo has deployed it yet). Reading it from an environment variable rather than
// scripts/config.ts (which only holds facts already fixed during A0) keeps this file honest about
// what it doesn't yet know, rather than hardcoding a URL that doesn't exist.

import { getSecret, SECRET_NAMES } from "@shared/secrets/index.ts";
import {
  SYNC_TASK_DISPATCH_URL,
  SYNC_TASKS_SERVICE_ACCOUNT_EMAIL,
} from "../../../../scripts/config.ts";
import { createDefaultTaskQueueClient, type TaskQueueClient } from "../../sync/taskQueue.ts";
import {
  handleShopifyWebhookRequest,
  type HandleShopifyWebhookDeps,
  type ShopifyWebhookRequest,
  type ShopifyWebhookResponse,
} from "./receiver.ts";

// Deploy-time facts an operator supplies once the Cloud Tasks queue and the deployed
// syncTaskDispatch function actually exist — see this step's final report for the exact
// provisioning commands. Defaults match the region/queue name already used in B1's own
// documented provisioning example.
const QUEUE_LOCATION = process.env.SYNC_TASKS_QUEUE_LOCATION ?? "asia-south1";
const QUEUE_NAME = process.env.SYNC_TASKS_QUEUE_NAME ?? "sync-tasks";
// Env var first (so another environment can override), falling back to the committed
// deployment identifier. The fallback exists because `firebase deploy --only functions` manages
// this service's environment and drops variables set by hand with `gcloud run services update` —
// without it, a routine redeploy silently reverts the receiver to throwing on every webhook,
// with no code change to point at. See scripts/config.ts's own comment.
const TASK_DISPATCH_URL = process.env.SYNC_TASK_DISPATCH_URL ?? SYNC_TASK_DISPATCH_URL;
const TASK_SERVICE_ACCOUNT_EMAIL =
  process.env.SYNC_TASKS_SERVICE_ACCOUNT_EMAIL ?? SYNC_TASKS_SERVICE_ACCOUNT_EMAIL;

let cachedDeps: HandleShopifyWebhookDeps | undefined;

async function getRuntimeDeps(): Promise<HandleShopifyWebhookDeps> {
  if (!cachedDeps) {
    if (!TASK_DISPATCH_URL) {
      throw new Error(
        "services/ingest/shopify/webhooks/runtime.ts: SYNC_TASK_DISPATCH_URL env var must be " +
          "set to the deployed syncTaskDispatch function's URL before this endpoint can run for " +
          "real — see this step's final report for the deploy sequence.",
      );
    }
    const webhookSecret = await getSecret(SECRET_NAMES.shopifyWebhookSecret);
    const taskQueue: TaskQueueClient = createDefaultTaskQueueClient({
      location: QUEUE_LOCATION,
      queue: QUEUE_NAME,
      targetUrl: TASK_DISPATCH_URL,
      serviceAccountEmail: TASK_SERVICE_ACCOUNT_EMAIL,
    });
    cachedDeps = { webhookSecret, taskQueue };
  }
  return cachedDeps;
}

/** The real Shopify webhook dispatch entry point — see functions/src/index.ts. */
export async function handleShopifyWebhookDispatch(
  req: ShopifyWebhookRequest,
): Promise<ShopifyWebhookResponse> {
  const deps = await getRuntimeDeps();
  return handleShopifyWebhookRequest(req, deps);
}
