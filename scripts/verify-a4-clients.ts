// A4 deliverable: proves the actual reusable clients built in services/ingest work
// end-to-end against live credentials — one trivial authenticated read per platform via
// `checkAuth()`. Unlike scripts/verify-credentials.ts (A0's ad hoc fetch calls, left as-is —
// that file's own header comment says it is deliberately not the reusable client), this
// exercises the real transport layer Phase B will import: secrets wrapper, BUC/leaky-bucket
// throttle plumbing, retry/error classification.
//
// Read-only. `checkAuth()` only ever performs a GET (Meta, fields=id on the ad account) or a
// `{ shop { name } }` query (Shopify) — no mutating call is made anywhere in this file, and
// no Firestore write happens either.
//
// Run: npm run verify-a4-clients

import { createMetaClient } from "../services/ingest/meta/client.ts";
import { createShopifyClient } from "../services/ingest/shopify/client.ts";

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function checkMeta(): Promise<CheckResult> {
  const name = "MetaClient.checkAuth() — GET ad account (fields=id)";
  try {
    const client = await createMetaClient();
    const result = await client.checkAuth();
    return { name, pass: result.authorized, detail: result.detail };
  } catch (err) {
    return { name, pass: false, detail: (err as Error).message };
  }
}

async function checkShopify(): Promise<CheckResult> {
  const name = "ShopifyClient.checkAuth() — { shop { name } }";
  try {
    const client = await createShopifyClient();
    const result = await client.checkAuth();
    return { name, pass: result.authorized, detail: result.detail };
  } catch (err) {
    return { name, pass: false, detail: (err as Error).message };
  }
}

async function main() {
  const results = await Promise.all([checkMeta(), checkShopify()]);

  console.log("\nA4 client verification (live)\n" + "-".repeat(60));
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
