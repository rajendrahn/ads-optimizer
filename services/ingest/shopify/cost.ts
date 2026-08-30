// Cost-aware throttling for the Shopify GraphQL Admin API. Every response carries its query
// cost and the current leaky-bucket state under `extensions.cost`:
//
//   {
//     "data": { ... },
//     "extensions": {
//       "cost": {
//         "requestedQueryCost": 21,
//         "actualQueryCost": 21,
//         "throttleStatus": {
//           "maximumAvailable": 1000,
//           "currentlyAvailable": 979,
//           "restoreRate": 50
//         }
//       }
//     }
//   }
//
// `throttleStatus` describes a leaky bucket: `currentlyAvailable` points now, refilling at
// `restoreRate` points/second up to `maximumAvailable`. The client (shopify/client.ts) parses
// this after every response and consults `decideShopifyThrottle` before the *next* request,
// so it waits for the bucket to refill enough rather than firing a query that gets rejected
// with a `THROTTLED` error.

export interface ShopifyThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  /** Points restored per second. */
  restoreRate: number;
}

export interface ShopifyCost {
  requestedQueryCost: number;
  actualQueryCost: number | null;
  throttleStatus: ShopifyThrottleStatus;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parses the `extensions` object from a GraphQL response body. Returns `null` — never throws
 * — for a missing/malformed cost block, since a parsing failure here must not break the
 * response it came attached to.
 */
export function parseShopifyCost(extensions: unknown): ShopifyCost | null {
  if (typeof extensions !== "object" || extensions === null) return null;
  const cost = (extensions as Record<string, unknown>).cost;
  if (typeof cost !== "object" || cost === null) return null;
  const costRec = cost as Record<string, unknown>;

  const throttle = costRec.throttleStatus;
  if (typeof throttle !== "object" || throttle === null) return null;
  const throttleRec = throttle as Record<string, unknown>;

  const maximumAvailable = toFiniteNumber(throttleRec.maximumAvailable);
  const currentlyAvailable = toFiniteNumber(throttleRec.currentlyAvailable);
  const restoreRate = toFiniteNumber(throttleRec.restoreRate);
  if (
    maximumAvailable === undefined ||
    currentlyAvailable === undefined ||
    restoreRate === undefined
  ) {
    return null;
  }
  if (restoreRate <= 0) return null; // nothing sane to compute a wait from

  return {
    requestedQueryCost: toFiniteNumber(costRec.requestedQueryCost) ?? 0,
    actualQueryCost: toFiniteNumber(costRec.actualQueryCost) ?? null,
    throttleStatus: { maximumAvailable, currentlyAvailable, restoreRate },
  };
}

export interface ShopifyThrottleDecision {
  shouldWait: boolean;
  waitMs: number;
  reason: string;
}

export interface DecideShopifyThrottleOptions {
  /** How many points the *next* query is expected to cost. Every real query's cost is
   * data-dependent and only known after the fact, so the caller supplies an estimate — Phase
   * B's job, since only it knows what it's about to ask for. Defaults to a conservative 50,
   * comfortably above a typical single-page query and well under the standard 1000-point
   * bucket, so an un-estimated call still leaves headroom instead of assuming it's free. */
  nextRequestEstimatedCost?: number;
  /** Extra headroom beyond the estimate, in points — default 0. */
  safetyMarginPoints?: number;
}

/**
 * Pure decision function, mirroring `meta/buc.ts`'s `decideBucBackoff`: given the most
 * recently observed leaky-bucket state, decide whether the next request should wait for the
 * bucket to refill, and for how long.
 */
export function decideShopifyThrottle(
  cost: ShopifyCost | null,
  opts: DecideShopifyThrottleOptions = {},
): ShopifyThrottleDecision {
  const estimatedCost = opts.nextRequestEstimatedCost ?? 50;
  const margin = opts.safetyMarginPoints ?? 0;

  if (!cost) {
    return { shouldWait: false, waitMs: 0, reason: "no cost data yet" };
  }

  const needed = estimatedCost + margin;
  const available = cost.throttleStatus.currentlyAvailable;
  if (available >= needed) {
    return {
      shouldWait: false,
      waitMs: 0,
      reason: `${available} points available, ${needed} needed`,
    };
  }

  const deficit = needed - available;
  const waitMs = Math.ceil((deficit / cost.throttleStatus.restoreRate) * 1000);
  return {
    shouldWait: true,
    waitMs,
    reason: `${available} points available, ${needed} needed, restoring at ${cost.throttleStatus.restoreRate}/s`,
  };
}
