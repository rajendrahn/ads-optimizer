import { describe, expect, it, vi } from "vitest";
import { ShopifyClient } from "../client.ts";
import { fetchAllUpdatedOrders, fetchUpdatedOrdersPage } from "./graphqlFetch.ts";
import type { RawGraphqlOrderNode } from "./graphqlNormalize.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function noopSleep(): (ms: number) => Promise<void> {
  return vi.fn().mockResolvedValue(undefined);
}

function minimalOrderNode(id: string, updatedAt: string): RawGraphqlOrderNode {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    createdAt: updatedAt,
    updatedAt,
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    currencyCode: "INR",
    customer: null,
    billingAddress: null,
    shippingAddress: null,
    subtotalPriceSet: { shopMoney: { amount: "0.0" } },
    totalDiscountsSet: { shopMoney: { amount: "0.0" } },
    totalShippingPriceSet: { shopMoney: { amount: "0.0" } },
    totalPriceSet: { shopMoney: { amount: "0.0" } },
    lineItems: { edges: [] },
    refunds: [],
  };
}

function pageResponse(
  nodes: RawGraphqlOrderNode[],
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return jsonResponse({
    data: {
      orders: {
        pageInfo: { hasNextPage, endCursor },
        edges: nodes.map((node) => ({ node })),
      },
    },
  });
}

describe("fetchUpdatedOrdersPage", () => {
  it("builds an updated_at:>= query filter and returns the page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        pageResponse([minimalOrderNode("1", "2026-08-01T00:00:00Z")], false, null),
      );
    const client = new ShopifyClient({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    const result = await fetchUpdatedOrdersPage(client, {
      updatedAtOrAfter: new Date("2026-07-01T00:00:00Z"),
      cursor: null,
    });

    expect(result.orders).toHaveLength(1);
    expect(result.hasNextPage).toBe(false);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { variables: Record<string, unknown> };
    expect(body.variables.query).toBe("updated_at:>='2026-07-01T00:00:00.000Z'");
    expect(body.variables.first).toBe(25);
    expect(body.variables.after).toBeNull();
  });
});

describe("fetchAllUpdatedOrders", () => {
  it("pages until hasNextPage is false, calling onPage for each page in order", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        pageResponse([minimalOrderNode("1", "2026-08-01T00:00:00Z")], true, "cursor1"),
      )
      .mockResolvedValueOnce(
        pageResponse([minimalOrderNode("2", "2026-08-02T00:00:00Z")], false, null),
      );
    const client = new ShopifyClient({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    const seenPages: string[][] = [];
    await fetchAllUpdatedOrders(client, new Date("2026-07-01T00:00:00Z"), async (page) => {
      seenPages.push(page.orders.map((o) => o.id));
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(seenPages).toEqual([["gid://shopify/Order/1"], ["gid://shopify/Order/2"]]);

    // Second call carries the first page's cursor as `after`.
    const [, secondInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string) as {
      variables: Record<string, unknown>;
    };
    expect(secondBody.variables.after).toBe("cursor1");
  });

  it("stops immediately on a single page with hasNextPage: false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(pageResponse([], false, null));
    const client = new ShopifyClient({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    const pages: unknown[] = [];
    await fetchAllUpdatedOrders(client, new Date(), async (page) => {
      pages.push(page);
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(pages).toHaveLength(1);
  });
});
