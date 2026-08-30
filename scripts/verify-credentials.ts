// A0 deliverable: proves every credential collected during setup actually works, with one
// minimal live call each. This is deliberately NOT a reusable API client (that's A4) — just
// enough ad hoc logic to fail loudly and specifically here, rather than confusingly in B2/B3/B5/D3.
//
// Run: npm run verify-credentials

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import {
  GCP_PROJECT_ID,
  META_API_VERSION,
  META_AD_ACCOUNT_ID,
  SHOPIFY_SHOP_DOMAIN,
  SHOPIFY_API_VERSION,
  ANTHROPIC_MODEL,
} from "./config.ts";

const secretClient = new SecretManagerServiceClient();

async function getSecret(name: string): Promise<string> {
  const [version] = await secretClient.accessSecretVersion({
    name: `projects/${GCP_PROJECT_ID}/secrets/${name}/versions/latest`,
  });
  const value = version.payload?.data?.toString().trim();
  if (!value) {
    throw new Error(`Secret ${name} is empty or missing`);
  }
  return value;
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function checkMeta(): Promise<CheckResult> {
  const name = "Meta — fetch ad account name";
  try {
    const token = await getSecret("meta-system-user-token");
    const url = `https://graph.facebook.com/${META_API_VERSION}/${META_AD_ACCOUNT_ID}?fields=name&access_token=${token}`;
    const res = await fetch(url);
    const body = (await res.json()) as { name?: string; error?: { message: string } };
    if (!res.ok || !body.name) {
      return { name, pass: false, detail: body.error?.message ?? `HTTP ${res.status}` };
    }
    return { name, pass: true, detail: `account name: "${body.name}"` };
  } catch (err) {
    return { name, pass: false, detail: (err as Error).message };
  }
}

async function checkShopify(): Promise<CheckResult> {
  const name = "Shopify — fetch shop record";
  try {
    const token = await getSecret("shopify-admin-token");
    const res = await fetch(
      `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "{ shop { name } }" }),
      },
    );
    const body = (await res.json()) as {
      data?: { shop?: { name?: string } };
      errors?: unknown;
    };
    const shopName = body.data?.shop?.name;
    if (!res.ok || !shopName) {
      return { name, pass: false, detail: JSON.stringify(body.errors ?? `HTTP ${res.status}`) };
    }
    return { name, pass: true, detail: `shop name: "${shopName}"` };
  } catch (err) {
    return { name, pass: false, detail: (err as Error).message };
  }
}

async function checkAnthropic(): Promise<CheckResult> {
  const name = `Anthropic — one-token ${ANTHROPIC_MODEL} call`;
  try {
    const apiKey = await getSecret("anthropic-api-key");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      // No `temperature` — Fable 5 rejects it with a 400. Thinking is always on.
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const body = (await res.json()) as { stop_reason?: string; error?: { message: string } };
    if (!res.ok) {
      const hint =
        res.status === 400
          ? " (400 here usually means the org is on zero data retention — Fable 5 requires 30-day retention)"
          : "";
      return { name, pass: false, detail: `${body.error?.message ?? `HTTP ${res.status}`}${hint}` };
    }
    return { name, pass: true, detail: `stop_reason: "${body.stop_reason}"` };
  } catch (err) {
    return { name, pass: false, detail: (err as Error).message };
  }
}

async function main() {
  const results = await Promise.all([checkMeta(), checkShopify(), checkAnthropic()]);

  console.log("\nCredential verification\n" + "-".repeat(60));
  for (const r of results) {
    const status = r.pass ? "PASS" : "FAIL";
    console.log(`[${status}] ${r.name}\n       ${r.detail}`);
  }
  console.log("-".repeat(60));

  const allPass = results.every((r) => r.pass);
  console.log(allPass ? "All checks passed.\n" : "Some checks FAILED — see above.\n");
  process.exit(allPass ? 0 : 1);
}

main();
