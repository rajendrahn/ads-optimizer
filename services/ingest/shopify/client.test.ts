import { describe, expect, it, vi } from "vitest";
import { ShopifyClient } from "./client.ts";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function noopSleep(): (ms: number) => Promise<void> {
  return vi.fn().mockResolvedValue(undefined);
}

function costExtensions(currentlyAvailable: number, restoreRate = 50) {
  return {
    cost: {
      requestedQueryCost: 1,
      actualQueryCost: 1,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable, restoreRate },
    },
  };
}

describe("ShopifyClient.query", () => {
  it("POSTs the query with the access token header and returns data", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { shop: { name: "Sparkle and Glow" } } }));
    const client = new ShopifyClient({
      shopDomain: "shopsparkleandglow.myshopify.com",
      accessToken: "shpat_xxx",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    const result = await client.query<{ shop: { name: string } }>("{ shop { name } }");

    expect(result.data.shop.name).toBe("Sparkle and Glow");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://shopsparkleandglow.myshopify.com/admin/api/2025-01/graphql.json");
    expect((init.headers as Record<string, string>)["X-Shopify-Access-Token"]).toBe("shpat_xxx");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "{ shop { name } }",
      variables: undefined,
    });
  });

  it("stores the parsed cost/throttle state from the response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: {}, extensions: costExtensions(950) }));
    const client = new ShopifyClient({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
      apiVersion: "2025-01",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    await client.query("{ shop { name } }");

    expect(client.getLastCost()?.throttleStatus.currentlyAvailable).toBe(950);
  });

  it("waits before a request when the bucket doesn't have enough points for the estimated cost", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: {}, extensions: costExtensions(10, 50) }))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));
    const sleepImpl = noopSleep();
    const onThrottle = vi.fn();
    const client = new ShopifyClient({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
      apiVersion: "2025-01",
      fetchImpl,
      sleepImpl,
      onThrottle,
    });

    await client.query("{ a }"); // leaves the bucket at 10/1000
    await client.query("{ b }", undefined, { estimatedCost: 100 }); // should wait first

    expect(onThrottle).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a THROTTLED error and eventually succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { shop: { name: "ok" } } }));
    const client = new ShopifyClient({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
      apiVersion: "2025-01",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    const result = await client.query<{ shop: { name: string } }>("{ shop { name } }");

    expect(result.data.shop.name).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry an ACCESS_DENIED error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ errors: [{ message: "denied", extensions: { code: "ACCESS_DENIED" } }] }),
      );
    const client = new ShopifyClient({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
      apiVersion: "2025-01",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    await expect(client.query("{ shop { name } }")).rejects.toMatchObject({ kind: "unauthorized" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("ShopifyClient.checkAuth", () => {
  it("reports authorized:true on a successful { shop { name } } call", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { shop: { name: "Sparkle and Glow" } } }));
    const client = new ShopifyClient({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
      apiVersion: "2025-01",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    const result = await client.checkAuth();

    expect(result.authorized).toBe(true);
    expect(result.detail).toContain("Sparkle and Glow");
  });

  it("reports authorized:false, without throwing, on an unauthenticated failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { status: 401 }));
    const client = new ShopifyClient({
      shopDomain: "shop.myshopify.com",
      accessToken: "bad",
      apiVersion: "2025-01",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    const result = await client.checkAuth();

    expect(result.authorized).toBe(false);
  });

  it("propagates a non-auth failure rather than swallowing it as unauthorized", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 }));
    const client = new ShopifyClient({
      shopDomain: "shop.myshopify.com",
      accessToken: "tok",
      apiVersion: "2025-01",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    await expect(client.checkAuth()).rejects.toMatchObject({ kind: "server_error" });
  });
});
