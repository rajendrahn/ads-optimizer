// Shopify GraphQL Admin API transport client — A4. GraphQL only, per §0.2 ("REST is legacy —
// do not use it"). Transport only: `query()` takes an arbitrary query/variables string and
// returns the parsed `data` verbatim — no knowledge of orders, line items or any other
// Shopify resource. That normalization is Phase B's job (B5).

import { SHOPIFY_API_VERSION, SHOPIFY_SHOP_DOMAIN } from "../../../scripts/config.ts";
import { getSecret } from "@shared/secrets/client.ts";
import { SECRET_NAMES } from "@shared/secrets/names.ts";
import { ApiError } from "../http/errors.ts";
import { withRetry } from "../http/retry.ts";
import { sleep as realSleep } from "../http/sleep.ts";
import {
  decideShopifyThrottle,
  parseShopifyCost,
  type ShopifyCost,
  type ShopifyThrottleDecision,
} from "./cost.ts";
import { classifyShopifyError } from "./errors.ts";

export interface ShopifyClientOptions {
  shopDomain: string;
  accessToken: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  onThrottle?: (decision: ShopifyThrottleDecision) => void;
}

export interface ShopifyQueryResult<T> {
  data: T;
  cost: ShopifyCost | null;
}

export interface ShopifyQueryOptions {
  /** How many leaky-bucket points this specific query is expected to cost — passed through
   * to `decideShopifyThrottle`. Only the caller (Phase B) knows what a given query costs;
   * left unset, the throttle decision falls back to its own conservative default. */
  estimatedCost?: number;
}

export class ShopifyClient {
  private readonly shopDomain: string;
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly onThrottle: ((decision: ShopifyThrottleDecision) => void) | undefined;
  private lastCost: ShopifyCost | null = null;

  constructor(opts: ShopifyClientOptions) {
    this.shopDomain = opts.shopDomain;
    this.accessToken = opts.accessToken;
    this.apiVersion = opts.apiVersion ?? SHOPIFY_API_VERSION;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? realSleep;
    this.onThrottle = opts.onThrottle;
  }

  /** The most recently observed leaky-bucket state, or `null` before any request has
   * completed. */
  getLastCost(): ShopifyCost | null {
    return this.lastCost;
  }

  /**
   * One GraphQL request. Handles, in order: cost-aware pre-emptive wait (if the last
   * response left too little of the bucket for this query's estimated cost), the request
   * itself with retry on retryable failures, and cost parsing on the response (stored for
   * the *next* call's pre-emptive check).
   */
  async query<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    opts: ShopifyQueryOptions = {},
  ): Promise<ShopifyQueryResult<T>> {
    await this.preemptiveThrottle(opts.estimatedCost);

    return withRetry(
      async () => {
        const res = await this.fetchImpl(this.endpoint(), {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": this.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
        });

        const body: unknown = await res.json().catch(() => undefined);
        this.lastCost = parseShopifyCost(
          typeof body === "object" && body !== null
            ? (body as { extensions?: unknown }).extensions
            : undefined,
        );

        const errors =
          typeof body === "object" &&
          body !== null &&
          Array.isArray((body as { errors?: unknown }).errors)
            ? (body as { errors: unknown[] }).errors
            : [];
        if (!res.ok || errors.length > 0) {
          throw classifyShopifyError(res.status, body);
        }
        return { data: (body as { data: T }).data, cost: this.lastCost };
      },
      { sleep: this.sleepImpl },
    );
  }

  /**
   * §9.6's health check: one minimal live query (`{ shop { name } }`, the same trivial call
   * A0's verify-credentials.ts established), classified into authorized/not. Does not
   * attempt to distinguish `no_new_data` — see services/ingest/health.ts.
   */
  async checkAuth(): Promise<{ authorized: boolean; detail: string }> {
    try {
      const result = await this.query<{ shop: { name?: string } }>("{ shop { name } }");
      return { authorized: true, detail: `shop name: "${result.data.shop.name ?? "unknown"}"` };
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unauthorized") {
        return { authorized: false, detail: err.message };
      }
      throw err;
    }
  }

  private endpoint(): string {
    return `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
  }

  private async preemptiveThrottle(estimatedCost?: number): Promise<void> {
    const decision = decideShopifyThrottle(this.lastCost, {
      nextRequestEstimatedCost: estimatedCost,
    });
    if (decision.shouldWait) {
      this.onThrottle?.(decision);
      await this.sleepImpl(decision.waitMs);
    }
  }
}

/**
 * Resolves the Shopify Admin API access token from Secret Manager (by the exact A0 name —
 * SECRET_NAMES.shopifyAdminToken) and the shop domain/API version recorded in `SETUP.md`,
 * and builds a ready client. Every option can still be overridden, e.g. for tests.
 */
export async function createShopifyClient(
  opts: Partial<ShopifyClientOptions> = {},
): Promise<ShopifyClient> {
  const accessToken = opts.accessToken ?? (await getSecret(SECRET_NAMES.shopifyAdminToken));
  const shopDomain = opts.shopDomain ?? SHOPIFY_SHOP_DOMAIN;
  return new ShopifyClient({ ...opts, accessToken, shopDomain });
}
