// B6's subscription definitions (§9.5, §25) — "defined in code, but NOT registered against the
// live store" per this step's explicit safety constraint (`webhookSubscriptionCreate` is a
// mutating Admin API call; running it now would start real production traffic arriving at
// infrastructure that doesn't exist yet — no Cloud Tasks queue, no deployed receiver). Nothing
// in this file, or anywhere else in this step, calls Shopify's Admin API. It exists so the exact
// mutation an operator needs is generated from the same source of truth the receiver/processor
// use (the topic list, the header-topic mapping), not hand-typed separately and left to drift.
//
// Shopify delivers a webhook's HTTP `X-Shopify-Topic` header in slash-form (`orders/create`)
// regardless of whether the subscription was created via the REST or GraphQL Admin API, or which
// GraphQL `WebhookSubscriptionTopic` enum value was used to create it — `headerTopic` below is
// what processTask.ts/receiver.ts actually see on the wire; `graphqlTopic` is only the value
// `webhookSubscriptionCreate`'s `topic` argument takes.

export interface ShopifyWebhookTopicDef {
  /** `WebhookSubscriptionTopic` enum value for the `webhookSubscriptionCreate` mutation. */
  graphqlTopic: string;
  /** The `X-Shopify-Topic` header value a real delivery carries — what processTask.ts routes on. */
  headerTopic: string;
}

/** B6's deliverable list, verbatim: "Subscriptions for order create/update, refund create, order
 * cancel." Nothing else — Web Pixel / customer events stay explicitly out of scope (§7.2). */
export const SHOPIFY_WEBHOOK_TOPICS: readonly ShopifyWebhookTopicDef[] = [
  { graphqlTopic: "ORDERS_CREATE", headerTopic: "orders/create" },
  { graphqlTopic: "ORDERS_UPDATED", headerTopic: "orders/updated" },
  { graphqlTopic: "ORDERS_CANCELLED", headerTopic: "orders/cancelled" },
  { graphqlTopic: "REFUNDS_CREATE", headerTopic: "refunds/create" },
];

/**
 * Builds the exact `webhookSubscriptionCreate` GraphQL mutation text an operator would run
 * against the Shopify Admin API to register one topic for real. Pure string-building — never
 * executed by this step's own code or tests. See this step's final report for the complete
 * per-topic command list and the infrastructure (Cloud Tasks queue, deployed receiver URL) that
 * must exist first.
 */
export function buildWebhookSubscriptionMutation(
  graphqlTopic: string,
  callbackUrl: string,
): string {
  return [
    "mutation {",
    `  webhookSubscriptionCreate(`,
    `    topic: ${graphqlTopic}`,
    `    webhookSubscription: { callbackUrl: "${callbackUrl}", format: JSON }`,
    "  ) {",
    "    webhookSubscription { id topic callbackUrl }",
    "    userErrors { field message }",
    "  }",
    "}",
  ].join("\n");
}
