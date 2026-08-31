import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInMemoryTaskQueueClient } from "../../sync/taskQueue.ts";
import { handleShopifyWebhookRequest } from "./receiver.ts";

const SECRET = "recv-test-secret";
const BODY = JSON.stringify({ id: "999", updated_at: "2026-08-30T00:00:00Z" });

/** A real, independently computed signature — the same "not a stubbed comparison" requirement
 * as verify.test.ts, applied at this layer: the valid-path tests below prove the whole receiver
 * accepts a genuine signature, not a mocked-out verify() call. */
function realHmac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("base64");
}

function baseHeaders() {
  return { hmac: realHmac(BODY, SECRET), topic: "orders/create", webhookId: "wh_1" };
}

describe("handleShopifyWebhookRequest", () => {
  it("valid signature: acknowledges 200 and enqueues exactly one Cloud Task, without touching Firestore", async () => {
    const taskQueue = createInMemoryTaskQueueClient();
    const result = await handleShopifyWebhookRequest(
      { rawBody: BODY, headers: baseHeaders() },
      { webhookSecret: SECRET, taskQueue },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    expect(taskQueue.enqueued).toHaveLength(1);
    expect(taskQueue.enqueued[0]).toMatchObject({
      taskType: "SHOPIFY_PROCESS_WEBHOOK",
      taskId: "wh_1", // the webhook id — see processTask.ts's idempotency note
      payload: {
        topic: "orders/create",
        webhookId: "wh_1",
        body: { id: "999", updated_at: "2026-08-30T00:00:00Z" },
      },
    });
  });

  it("invalid signature: refuses with 401 and enqueues nothing", async () => {
    const taskQueue = createInMemoryTaskQueueClient();
    const wrongSignature = realHmac(BODY, "a-completely-different-secret");

    const result = await handleShopifyWebhookRequest(
      { rawBody: BODY, headers: { ...baseHeaders(), hmac: wrongSignature } },
      { webhookSecret: SECRET, taskQueue },
    );

    expect(result.status).toBe(401);
    expect(taskQueue.enqueued).toHaveLength(0);
  });

  it("missing signature header: refuses with 401 and enqueues nothing", async () => {
    const taskQueue = createInMemoryTaskQueueClient();
    const result = await handleShopifyWebhookRequest(
      { rawBody: BODY, headers: { ...baseHeaders(), hmac: undefined } },
      { webhookSecret: SECRET, taskQueue },
    );
    expect(result.status).toBe(401);
    expect(taskQueue.enqueued).toHaveLength(0);
  });

  it("a signature valid for a different body is refused (proves verification binds to the exact raw bytes)", async () => {
    const taskQueue = createInMemoryTaskQueueClient();
    const differentBody = JSON.stringify({ id: "999", updated_at: "2026-08-30T00:00:01Z" });
    const signatureForDifferentBody = realHmac(differentBody, SECRET);

    const result = await handleShopifyWebhookRequest(
      { rawBody: BODY, headers: { ...baseHeaders(), hmac: signatureForDifferentBody } },
      { webhookSecret: SECRET, taskQueue },
    );

    expect(result.status).toBe(401);
    expect(taskQueue.enqueued).toHaveLength(0);
  });

  it("valid signature but missing topic header: 400, no enqueue", async () => {
    const taskQueue = createInMemoryTaskQueueClient();
    const result = await handleShopifyWebhookRequest(
      { rawBody: BODY, headers: { ...baseHeaders(), topic: undefined } },
      { webhookSecret: SECRET, taskQueue },
    );
    expect(result.status).toBe(400);
    expect(taskQueue.enqueued).toHaveLength(0);
  });

  it("valid signature but missing webhookId header: 400, no enqueue", async () => {
    const taskQueue = createInMemoryTaskQueueClient();
    const result = await handleShopifyWebhookRequest(
      { rawBody: BODY, headers: { ...baseHeaders(), webhookId: undefined } },
      { webhookSecret: SECRET, taskQueue },
    );
    expect(result.status).toBe(400);
    expect(taskQueue.enqueued).toHaveLength(0);
  });

  it("valid signature but unparseable JSON body: 400, no enqueue", async () => {
    const taskQueue = createInMemoryTaskQueueClient();
    const notJson = "{not json";
    const result = await handleShopifyWebhookRequest(
      {
        rawBody: notJson,
        headers: { hmac: realHmac(notJson, SECRET), topic: "orders/create", webhookId: "wh_2" },
      },
      { webhookSecret: SECRET, taskQueue },
    );
    expect(result.status).toBe(400);
    expect(taskQueue.enqueued).toHaveLength(0);
  });

  it("accepts a Buffer rawBody identically to the equivalent string", async () => {
    const taskQueue = createInMemoryTaskQueueClient();
    const result = await handleShopifyWebhookRequest(
      { rawBody: Buffer.from(BODY, "utf8"), headers: baseHeaders() },
      { webhookSecret: SECRET, taskQueue },
    );
    expect(result.status).toBe(200);
    expect(taskQueue.enqueued).toHaveLength(1);
  });

  it("a replayed delivery (same webhookId) enqueues a second Cloud Task with the same taskId — Cloud Tasks' own dedupe plus runSyncTask's taskId lookup is what makes replay a no-op end to end, not this function", async () => {
    const taskQueue = createInMemoryTaskQueueClient();
    await handleShopifyWebhookRequest(
      { rawBody: BODY, headers: baseHeaders() },
      { webhookSecret: SECRET, taskQueue },
    );
    await handleShopifyWebhookRequest(
      { rawBody: BODY, headers: baseHeaders() },
      { webhookSecret: SECRET, taskQueue },
    );

    expect(taskQueue.enqueued).toHaveLength(2);
    expect(taskQueue.enqueued[0].taskId).toBe(taskQueue.enqueued[1].taskId);
  });
});
