// Barrel export for A4's transport layer. Phase B imports clients from here (or from the
// individual files directly); nothing in this directory fetches or normalizes any specific
// Meta/Shopify resource — that's B2/B3/B5.

export { ApiError, type ApiErrorKind, type ApiErrorOptions } from "./http/errors.ts";
export { withRetry, computeBackoffDelayMs, type RetryOptions } from "./http/retry.ts";
export { sleep } from "./http/sleep.ts";

export { classifySyncStatus, type ClassifySyncStatusInput } from "./health.ts";

export {
  MetaClient,
  createMetaClient,
  type MetaClientOptions,
  type MetaGetResult,
} from "./meta/client.ts";
export {
  parseBucHeader,
  decideBucBackoff,
  type BucUsageEntry,
  type ParsedBucUsage,
  type BucThrottleDecision,
  type DecideBucBackoffOptions,
} from "./meta/buc.ts";
export { classifyMetaError } from "./meta/errors.ts";

export {
  ShopifyClient,
  createShopifyClient,
  type ShopifyClientOptions,
  type ShopifyQueryResult,
  type ShopifyQueryOptions,
} from "./shopify/client.ts";
export {
  parseShopifyCost,
  decideShopifyThrottle,
  type ShopifyCost,
  type ShopifyThrottleStatus,
  type ShopifyThrottleDecision,
  type DecideShopifyThrottleOptions,
} from "./shopify/cost.ts";
export { classifyShopifyError } from "./shopify/errors.ts";
