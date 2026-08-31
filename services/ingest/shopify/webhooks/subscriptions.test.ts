import { describe, expect, it } from "vitest";
import { buildWebhookSubscriptionMutation, SHOPIFY_WEBHOOK_TOPICS } from "./subscriptions.ts";

describe("SHOPIFY_WEBHOOK_TOPICS", () => {
  it("covers exactly B6's deliverable list: order create/update/cancel, refund create — nothing else", () => {
    const headerTopics = SHOPIFY_WEBHOOK_TOPICS.map((t) => t.headerTopic).sort();
    expect(headerTopics).toEqual(
      ["orders/cancelled", "orders/create", "orders/updated", "refunds/create"].sort(),
    );
  });

  it("every topic has a non-empty graphqlTopic distinct from its headerTopic", () => {
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      expect(topic.graphqlTopic.length).toBeGreaterThan(0);
      expect(topic.headerTopic.length).toBeGreaterThan(0);
      expect(topic.graphqlTopic).not.toBe(topic.headerTopic);
    }
  });
});

describe("buildWebhookSubscriptionMutation", () => {
  it("embeds the exact topic and callback URL an operator would need, and requests JSON format", () => {
    const mutation = buildWebhookSubscriptionMutation(
      "ORDERS_CREATE",
      "https://example.com/shopifyWebhookReceive",
    );
    expect(mutation).toContain("topic: ORDERS_CREATE");
    expect(mutation).toContain('callbackUrl: "https://example.com/shopifyWebhookReceive"');
    expect(mutation).toContain("format: JSON");
    expect(mutation).toContain("webhookSubscriptionCreate");
    expect(mutation).toContain("userErrors { field message }");
  });

  it("produces a distinct, valid mutation for every registered topic", () => {
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      const mutation = buildWebhookSubscriptionMutation(
        topic.graphqlTopic,
        "https://x.example/hook",
      );
      expect(mutation).toContain(`topic: ${topic.graphqlTopic}`);
    }
  });
});
