// Registers B6's Shopify webhook subscriptions against the LIVE store.
//
// ⚠️ MUTATING. After this runs, the real store starts POSTing order and refund events at the
// deployed receiver. Prerequisites, all verified before this was first run:
//   - shopifyWebhookReceive deployed and PUBLICLY invocable (Shopify sends no auth token)
//   - it can read `shopify-webhook-secret` (else HMAC verification 500s on every request)
//   - SYNC_TASK_DISPATCH_URL resolvable, so a verified webhook can actually be enqueued
//   - an unsigned POST returns 401, proving the endpoint refuses anything unsigned
//
// Topics and mutation text come from B6's own `SHOPIFY_WEBHOOK_TOPICS` /
// `buildWebhookSubscriptionMutation` - the same source of truth `processTask.ts` routes on - so
// a topic can never be registered that the processor does not handle.
//
// Run:
//   npx tsx scripts/register-webhooks.ts            # list what IS registered, change nothing
//   npx tsx scripts/register-webhooks.ts --register # actually register
//   npx tsx scripts/register-webhooks.ts --register --callback-url https://...

import { getSecret } from "@shared/secrets/index.ts";
import {
  SHOPIFY_WEBHOOK_TOPICS,
  buildWebhookSubscriptionMutation,
} from "@services/ingest/shopify/webhooks/subscriptions.ts";
import { SHOPIFY_SHOP_DOMAIN, SHOPIFY_API_VERSION } from "./config.ts";

const args = process.argv.slice(2);
const shouldRegister = args.includes("--register");

function flagValue(flag: string): string | null {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1] ?? null;
}

const DEFAULT_CALLBACK_URL = "https://shopifywebhookreceive-tferenuybq-el.a.run.app";
const callbackUrl = flagValue("--callback-url") ?? DEFAULT_CALLBACK_URL;

async function shopifyGraphql(token: string, query: string): Promise<unknown> {
  const res = await fetch(
    `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    },
  );
  const body: unknown = await res.json();
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const token = await getSecret("shopify-admin-token");

  console.log(`shop        : ${SHOPIFY_SHOP_DOMAIN}`);
  console.log(`callbackUrl : ${callbackUrl}`);
  console.log("");

  // Always show current state first - registering a duplicate topic is a Shopify userError, and
  // seeing what already exists is the difference between "nothing happened" and "already done".
  const existing = (await shopifyGraphql(
    token,
    `{ webhookSubscriptions(first: 50) { edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } } }`,
  )) as {
    data?: {
      webhookSubscriptions?: {
        edges?: { node?: { id?: string; topic?: string; endpoint?: { callbackUrl?: string } } }[];
      };
    };
  };
  const edges = existing.data?.webhookSubscriptions?.edges ?? [];
  console.log(`currently registered: ${edges.length}`);
  for (const e of edges) {
    console.log(`  ${e.node?.topic}  ->  ${e.node?.endpoint?.callbackUrl ?? "(non-http)"}`);
  }

  if (!shouldRegister) {
    console.log("");
    console.log("(dry run - pass --register to create the subscriptions below)");
    for (const t of SHOPIFY_WEBHOOK_TOPICS) console.log(`  would register ${t.graphqlTopic}`);
    return;
  }

  const alreadyRegistered = new Set(
    edges
      .filter((e) => e.node?.endpoint?.callbackUrl === callbackUrl)
      .map((e) => e.node?.topic ?? ""),
  );

  console.log("");
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    if (alreadyRegistered.has(topic.graphqlTopic)) {
      console.log(`  ${topic.graphqlTopic}: already registered at this URL, skipping`);
      continue;
    }
    const result = (await shopifyGraphql(
      token,
      buildWebhookSubscriptionMutation(topic.graphqlTopic, callbackUrl),
    )) as {
      data?: {
        webhookSubscriptionCreate?: {
          webhookSubscription?: { id?: string };
          userErrors?: { field?: string[]; message?: string }[];
        };
      };
    };
    const payload = result.data?.webhookSubscriptionCreate;
    const errors = payload?.userErrors ?? [];
    if (errors.length > 0) {
      console.log(`  ${topic.graphqlTopic}: FAILED - ${errors.map((e) => e.message).join("; ")}`);
    } else {
      console.log(`  ${topic.graphqlTopic}: registered (${payload?.webhookSubscription?.id})`);
    }
  }

  console.log("");
  console.log("The live store will now POST these events to the receiver as they happen.");
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
