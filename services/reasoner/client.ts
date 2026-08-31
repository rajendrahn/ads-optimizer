// D3's Anthropic client — first-party Claude API only (§0.2, §19.1), never Vertex, never a
// raw `fetch`. Credentials come from Secret Manager under A0's fixed name (`shared/secrets`,
// never a hardcoded key or an env var) — mirrors A4's `createMetaClient`/`createShopifyClient`
// pattern: a cached factory that resolves the secret once per process.

import Anthropic from "@anthropic-ai/sdk";
import { getSecret, SECRET_NAMES } from "@shared/secrets/index.ts";

let cached: Anthropic | undefined;

export interface CreateReasonerClientOptions {
  /** Test-only seam: inject a pre-built client (e.g. one pointed at a mock fetch) instead of
   * resolving a real API key. Never used in production code paths. */
  clientOverride?: Anthropic;
}

/** Resolves `anthropic-api-key` from Secret Manager and builds the SDK client. Cached per
 * process — an API key is a long-lived credential, same reasoning as `shared/secrets/client.ts`
 * itself caching the raw secret value. Never logs or otherwise surfaces the key. */
export async function createReasonerClient(
  options: CreateReasonerClientOptions = {},
): Promise<Anthropic> {
  if (options.clientOverride) return options.clientOverride;
  if (cached) return cached;

  const apiKey = await getSecret(SECRET_NAMES.anthropicApiKey);
  cached = new Anthropic({ apiKey });
  return cached;
}

/** Test-only seam: clear the cached client so a test can inject a fresh override. */
export function __resetReasonerClientForTests(): void {
  cached = undefined;
}
