// Hand-written ambient declaration for the esbuild-bundled artifact produced by
// functions/scripts/bundle.mjs from services/ingest/shopify/webhooks/index.ts (the root ESM
// project). Same pattern as functions/src/generated/syncBundle.d.ts (B1) — see that file's
// module comment for the full module-system rationale (`functions/` stays plain CommonJS,
// rootDir "src", and can never import `/shared`/`/services` directly).
//
// TypeScript's classic module resolution finds THIS .d.ts sitting right next to where the real
// shopifyWebhookBundle.js will be, resolving functions/src/index.ts's
// `import { handleShopifyWebhookDispatch } from "./generated/shopifyWebhookBundle"` — so `npm
// run typecheck` passes whether or not the bundle has actually been built. The real .js is
// generated only by `npm run build` (functions/package.json), lands at
// functions/lib/generated/shopifyWebhookBundle.js (gitignored, like the rest of
// functions/lib/), and is what Node actually loads at runtime.
//
// Keep this declaration to the smallest surface functions/src/index.ts actually needs (currently:
// one dispatch function) — the trade-off B1's syncBundle.d.ts already documented (a manually
// maintained mirror, nothing enforces it stays in sync except this comment) applies identically
// here.

// Deliberately NOT wrapped in `declare module "./generated/shopifyWebhookBundle" { ... }` — see
// syncBundle.d.ts's comment for why: this file IS that module under Node10 resolution.

export interface ShopifyWebhookRequestHeaders {
  hmac?: string | null;
  topic?: string | null;
  webhookId?: string | null;
}

export interface ShopifyWebhookDispatchRequest {
  rawBody: string | Buffer;
  headers: ShopifyWebhookRequestHeaders;
}

export interface ShopifyWebhookDispatchResponse {
  status: number;
  body: Record<string, unknown>;
}

/** The real Shopify webhook dispatch entry point — see
 * services/ingest/shopify/webhooks/runtime.ts. */
export declare function handleShopifyWebhookDispatch(
  request: ShopifyWebhookDispatchRequest,
): Promise<ShopifyWebhookDispatchResponse>;
