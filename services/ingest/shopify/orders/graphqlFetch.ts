// Plain paginated GraphQL fetch for SHOPIFY_SYNC_ORDERS (§7.2, §9.3) — "Incremental sync via
// `updated_at` watermark, over plain paginated GraphQL (no Bulk Operations needed — that
// machinery existed only for the historical backfill this replaces)."
//
// `read_orders` (not `read_all_orders`) restricts the underlying order set an app can see to
// orders created in roughly the last 60 days, enforced by Shopify itself regardless of the
// query filter used — verified live: a query filtered to `updated_at:>=<a date many months in
// the past>` still only returns orders within that rolling window. This means the `query`
// filter here only needs to express "updated since the watermark"; Shopify's own scope already
// bounds how far back any of it can reach. `sortKey: UPDATED_AT` (ascending, the default) means
// each page's last node carries the furthest-forward `updatedAt` seen so far — that's the new
// watermark candidate the caller (ordersSync.ts) advances to only after a successful run.

import type { ShopifyClient } from "../client.ts";
import type { RawGraphqlOrderNode } from "./graphqlNormalize.ts";

export const SYNC_ORDERS_QUERY = `
  query SyncOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          createdAt
          updatedAt
          cancelledAt
          displayFinancialStatus
          displayFulfillmentStatus
          currencyCode
          customer { id }
          billingAddress { countryCodeV2 }
          shippingAddress { countryCodeV2 }
          subtotalPriceSet { shopMoney { amount } }
          totalDiscountsSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          totalPriceSet { shopMoney { amount } }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                sku
                quantity
                product { id productType tags }
                variant { id }
                originalUnitPriceSet { shopMoney { amount } }
              }
            }
          }
          refunds {
            id
            createdAt
            totalRefundedSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

interface SyncOrdersResponse {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: RawGraphqlOrderNode }[];
  };
}

export interface FetchUpdatedOrdersPageOptions {
  /** Fetch orders whose `updated_at` is at or after this instant. */
  updatedAtOrAfter: Date;
  cursor: string | null;
  pageSize?: number;
  /** Passed through to `ShopifyClient.query`'s cost-aware pre-emptive throttle — a page of
   * `pageSize` orders each with up to 50 line items + all refunds is not cheap; a generous
   * default keeps the throttle conservative without needing per-account tuning here. */
  estimatedCost?: number;
}

export interface FetchUpdatedOrdersPageResult {
  orders: RawGraphqlOrderNode[];
  hasNextPage: boolean;
  endCursor: string | null;
  /** The raw response body, for archiving verbatim (§23) before any normalization. */
  raw: unknown;
}

export async function fetchUpdatedOrdersPage(
  client: ShopifyClient,
  opts: FetchUpdatedOrdersPageOptions,
): Promise<FetchUpdatedOrdersPageResult> {
  const pageSize = opts.pageSize ?? 25;
  const isoInstant = opts.updatedAtOrAfter.toISOString();
  const result = await client.query<SyncOrdersResponse>(
    SYNC_ORDERS_QUERY,
    {
      first: pageSize,
      after: opts.cursor,
      query: `updated_at:>='${isoInstant}'`,
    },
    { estimatedCost: opts.estimatedCost ?? 250 },
  );

  return {
    orders: result.data.orders.edges.map((e) => e.node),
    hasNextPage: result.data.orders.pageInfo.hasNextPage,
    endCursor: result.data.orders.pageInfo.endCursor,
    raw: result.data,
  };
}

/**
 * Pages through every order updated at or after `updatedAtOrAfter`, calling `onPage` once per
 * page (for archiving + writing) as it goes — so a task that fails partway through has already
 * durably written everything up to that point (the version guard makes re-processing a retried
 * page safe), rather than buffering the whole result set in memory first.
 */
export async function fetchAllUpdatedOrders(
  client: ShopifyClient,
  updatedAtOrAfter: Date,
  onPage: (page: FetchUpdatedOrdersPageResult) => Promise<void>,
  opts: { pageSize?: number; estimatedCost?: number } = {},
): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchUpdatedOrdersPage(client, {
      updatedAtOrAfter,
      cursor,
      pageSize: opts.pageSize,
      estimatedCost: opts.estimatedCost,
    });
    await onPage(page);
    if (!page.hasNextPage) break;
    cursor = page.endCursor;
  }
}
