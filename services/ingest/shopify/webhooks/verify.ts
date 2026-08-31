// Shopify webhook HMAC verification (§9.5, §25 "Shopify webhooks: Real time"; B6's deliverable
// list: "HTTPS endpoint with HMAC signature verification"). SETUP.md §3 notes that for a
// **custom** app (which this project uses — A0), the webhook signing secret is the app's own
// API secret key, not a separately-issued value; A0 already resolved that into Secret Manager
// under `shopify-webhook-secret` (shared/secrets/names.ts).
//
// Shopify signs the exact raw request body bytes with HMAC-SHA256, keyed by that secret, and
// base64-encodes the digest into the `X-Shopify-Hmac-Sha256` header. Verification MUST run
// against the raw bytes as received — re-serializing a parsed JSON object can reorder keys or
// change whitespace/number formatting and silently invalidate a legitimate signature — which is
// why every caller of this module threads a `string | Buffer` raw body through, never a parsed
// object (see receiver.ts).
//
// `timingSafeEqual` throws if given two buffers of different length, so the length check here
// isn't just an optimization — it's what keeps a malformed/short header from crashing this
// function instead of returning `false`.

import { createHmac, timingSafeEqual } from "node:crypto";

/** The raw HMAC-SHA256 digest Shopify would have sent for this exact body + secret,
 * base64-encoded. Exposed separately from the boolean check so tests can compute a real,
 * independently-derived signature rather than stubbing the comparison — see this directory's
 * test files. */
export function computeShopifyWebhookHmac(rawBody: string | Buffer, secret: string): string {
  const bodyBuffer = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return createHmac("sha256", secret).update(bodyBuffer).digest("base64");
}

/**
 * Verifies a webhook delivery's `X-Shopify-Hmac-Sha256` header against the raw request body and
 * the resolved `shopify-webhook-secret`. Returns `false` (never throws) for any of: a
 * missing/empty header, a header that isn't valid base64, a header of the wrong decoded length,
 * or a header that decodes but doesn't match — callers (receiver.ts) treat every `false` the
 * same way: refuse the request with 401, log nothing sensitive, never enqueue a task.
 */
export function verifyShopifyWebhookHmac(
  rawBody: string | Buffer,
  hmacHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!hmacHeader) return false;

  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }
  // An empty/whitespace header decodes to a zero-length buffer without throwing — reject
  // explicitly rather than relying on the length check below to happen to catch it.
  if (providedBuf.length === 0) return false;

  const expectedBuf = Buffer.from(computeShopifyWebhookHmac(rawBody, secret), "base64");
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
