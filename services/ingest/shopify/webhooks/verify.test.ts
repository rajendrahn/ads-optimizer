import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeShopifyWebhookHmac, verifyShopifyWebhookHmac } from "./verify.ts";

const SECRET = "test-webhook-secret";
const BODY = JSON.stringify({ id: 123, updated_at: "2026-08-30T00:00:00Z" });

/** Independently computed, NOT via computeShopifyWebhookHmac — this is what the "real computed
 * signature, not a stubbed comparison" requirement means: the test derives an expected value
 * using node:crypto directly, the same way Shopify itself would, rather than trusting the
 * module under test to grade its own homework. */
function referenceHmac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("base64");
}

describe("computeShopifyWebhookHmac", () => {
  it("matches an independently computed HMAC-SHA256/base64 digest", () => {
    expect(computeShopifyWebhookHmac(BODY, SECRET)).toBe(referenceHmac(BODY, SECRET));
  });

  it("accepts a Buffer body identically to the equivalent string", () => {
    expect(computeShopifyWebhookHmac(Buffer.from(BODY, "utf8"), SECRET)).toBe(
      computeShopifyWebhookHmac(BODY, SECRET),
    );
  });
});

describe("verifyShopifyWebhookHmac", () => {
  it("accepts a real, correctly computed signature", () => {
    const realSignature = referenceHmac(BODY, SECRET);
    expect(verifyShopifyWebhookHmac(BODY, realSignature, SECRET)).toBe(true);
  });

  it("accepts a real signature computed via the module's own compute function too", () => {
    const realSignature = computeShopifyWebhookHmac(BODY, SECRET);
    expect(verifyShopifyWebhookHmac(BODY, realSignature, SECRET)).toBe(true);
  });

  it("rejects a real signature computed over a different (tampered) body", () => {
    const signatureForOriginalBody = referenceHmac(BODY, SECRET);
    const tamperedBody = JSON.stringify({ id: 123, updated_at: "2026-08-30T00:00:01Z" });
    expect(verifyShopifyWebhookHmac(tamperedBody, signatureForOriginalBody, SECRET)).toBe(false);
  });

  it("rejects a real signature computed with the wrong secret", () => {
    const signatureWithWrongSecret = referenceHmac(BODY, "some-other-secret");
    expect(verifyShopifyWebhookHmac(BODY, signatureWithWrongSecret, SECRET)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyShopifyWebhookHmac(BODY, undefined, SECRET)).toBe(false);
    expect(verifyShopifyWebhookHmac(BODY, null, SECRET)).toBe(false);
    expect(verifyShopifyWebhookHmac(BODY, "", SECRET)).toBe(false);
  });

  it("rejects a header of the wrong decoded length without throwing", () => {
    expect(verifyShopifyWebhookHmac(BODY, "dG9vc2hvcnQ=", SECRET)).toBe(false);
  });

  it("rejects a header that is not valid base64 without throwing", () => {
    // Contains characters illegal in base64 — Buffer.from with "base64" is lenient about most
    // garbage, so this is deliberately something that still decodes to a wrong-length buffer
    // (covered above) as well as one that's plausibly-shaped but wrong.
    expect(() => verifyShopifyWebhookHmac(BODY, "not-a-real-signature!!", SECRET)).not.toThrow();
    expect(verifyShopifyWebhookHmac(BODY, "not-a-real-signature!!", SECRET)).toBe(false);
  });

  it("accepts a Buffer body identically to the equivalent string", () => {
    const realSignature = referenceHmac(BODY, SECRET);
    expect(verifyShopifyWebhookHmac(Buffer.from(BODY, "utf8"), realSignature, SECRET)).toBe(true);
  });
});
