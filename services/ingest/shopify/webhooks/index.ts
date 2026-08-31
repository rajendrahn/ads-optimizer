// Barrel for B6's Shopify webhooks ingestion — HMAC-verified HTTPS receiver, Cloud Tasks
// hand-off, and the version-guarded async processor. Also the esbuild entry point
// functions/scripts/bundle.mjs bundles into functions/lib/generated/shopifyWebhookBundle.js —
// see that script's comment and functions/src/generated/shopifyWebhookBundle.d.ts for why (same
// module-system boundary B1 documented for services/ingest/sync/index.ts). Keep this barrel's
// exported surface and that .d.ts in sync by hand; nothing enforces the two match automatically.

export { computeShopifyWebhookHmac, verifyShopifyWebhookHmac } from "./verify.ts";
export {
  normalizeWebhookOrder,
  normalizeWebhookRefund,
  refundAmountMinorUnits,
  resolveRefundCurrency,
  type NormalizeWebhookCtx,
  type NormalizeWebhookOrderResult,
  type RawWebhookLineItem,
  type RawWebhookMoneySet,
  type RawWebhookOrderPayload,
  type RawWebhookOrderRefund,
  type RawWebhookRefundLineItem,
  type RawWebhookRefundPayload,
  type RawWebhookTransaction,
} from "./normalize.ts";
export {
  shopifyProcessWebhookHandler,
  shopifyProcessWebhookRegistration,
  type ShopifyWebhookTaskPayload,
} from "./processTask.ts";
export {
  handleShopifyWebhookRequest,
  type HandleShopifyWebhookDeps,
  type ShopifyWebhookHeaders,
  type ShopifyWebhookRequest,
  type ShopifyWebhookResponse,
} from "./receiver.ts";
export { handleShopifyWebhookDispatch } from "./runtime.ts";
export {
  buildWebhookSubscriptionMutation,
  SHOPIFY_WEBHOOK_TOPICS,
  type ShopifyWebhookTopicDef,
} from "./subscriptions.ts";
