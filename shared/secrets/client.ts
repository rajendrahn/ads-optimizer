// Secret Manager access wrapper — A4's deliverable. Deliberately separate from
// scripts/verify-credentials.ts's inline `getSecret`, which that file's own header comment
// says is "NOT a reusable API client (that's A4)". This is the reusable one: every later
// step (Phase B ingestion, D3's reasoner) resolves credentials through here, by name, never
// by re-deriving a secret name or hardcoding a value.
//
// Secrets are read once per process and cached in memory (never on disk) — these are
// long-lived credentials (a Meta system user token, an Anthropic API key) that don't rotate
// mid-process, and a long-running Cloud Run reasoner or a sync task making many API calls
// should not re-hit Secret Manager on every request.

import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";

/**
 * The narrow slice of `SecretManagerServiceClient` this module actually calls — mirrors
 * `shared/firestore/versionGuard.ts`'s structural-typing approach so unit tests can inject a
 * hand-rolled fake instead of hitting real Secret Manager, without a cast at the call site
 * (a real `SecretManagerServiceClient` satisfies this automatically).
 */
export interface SecretManagerClientLike {
  // Tagged as a rest tuple (rather than exactly one element) so the real
  // `SecretManagerServiceClient` — whose `accessSecretVersion` resolves a 3-element tuple
  // `[response, request, options]` — satisfies this structurally with no cast needed.
  accessSecretVersion(request: {
    name: string;
  }): Promise<[{ payload?: { data?: Uint8Array | string | null } | null }, ...unknown[]]>;
}

const cache = new Map<string, string>();
let client: SecretManagerClientLike | undefined;

function getClient(): SecretManagerClientLike {
  if (!client) {
    client = new SecretManagerServiceClient();
  }
  return client;
}

/**
 * Test-only seam: inject a fake client and/or clear the cache. Never call this from
 * production code — real callers just call `getSecret`.
 */
export function __setSecretManagerClientForTests(fake: SecretManagerClientLike | undefined): void {
  client = fake;
  cache.clear();
}

/** Test-only seam: clear the in-memory cache without touching which client is wired up. */
export function __clearSecretCacheForTests(): void {
  cache.clear();
}

/**
 * Resolve one secret's latest version by its exact Secret Manager name (see
 * `shared/secrets/names.ts` / SETUP.md §5). Throws — does not return a placeholder or empty
 * string — when the secret is missing, has no version, or resolves to an empty value, since a
 * silently-empty credential fails confusingly deep inside a Meta/Shopify request instead of
 * here, where the cause is obvious.
 */
export async function getSecret(name: string, opts: { projectId?: string } = {}): Promise<string> {
  const projectId = opts.projectId ?? GCP_PROJECT_ID;
  const cacheKey = `${projectId}/${name}`;

  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const [version] = await getClient().accessSecretVersion({
    name: `projects/${projectId}/secrets/${name}/versions/latest`,
  });

  const raw = version.payload?.data;
  const value = (
    typeof raw === "string" ? raw : raw ? Buffer.from(raw).toString("utf8") : ""
  ).trim();
  if (!value) {
    throw new Error(`Secret "${name}" is empty or missing (project ${projectId})`);
  }

  cache.set(cacheKey, value);
  return value;
}
