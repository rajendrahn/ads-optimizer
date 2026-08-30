import { describe, expect, it, vi } from "vitest";
import { MetaClient } from "../client.ts";
import {
  fetchAccountCurrency,
  fetchAllAds,
  fetchAllAdsets,
  fetchAllCampaigns,
  fetchAllCreatives,
} from "./fetch.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function noopSleep() {
  return vi.fn().mockResolvedValue(undefined);
}

function clientWithSequence(bodies: unknown[]): {
  client: MetaClient;
  fetchImpl: ReturnType<typeof vi.fn>;
} {
  const fetchImpl = vi.fn();
  for (const body of bodies) fetchImpl.mockResolvedValueOnce(jsonResponse(body));
  const client = new MetaClient({ accessToken: "tok", fetchImpl, sleepImpl: noopSleep() });
  return { client, fetchImpl };
}

describe("fetchAccountCurrency", () => {
  it("returns the account's currency field", async () => {
    const { client } = clientWithSequence([{ currency: "INR" }]);
    await expect(fetchAccountCurrency(client)).resolves.toBe("INR");
  });

  it("throws when Meta returns no currency", async () => {
    const { client } = clientWithSequence([{}]);
    await expect(fetchAccountCurrency(client)).rejects.toThrow(/no currency/);
  });
});

describe("fetchAllCampaigns", () => {
  it("returns rows from a single page when there is no next cursor", async () => {
    const { client, fetchImpl } = clientWithSequence([
      { data: [{ id: "cmp_1" }, { id: "cmp_2" }], paging: { cursors: { after: "abc" } } },
    ]);
    const result = await fetchAllCampaigns(client);
    expect(result.rows).toHaveLength(2);
    expect(result.pages).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows the after cursor across multiple pages until paging.next is absent", async () => {
    const { client, fetchImpl } = clientWithSequence([
      {
        data: [{ id: "cmp_1" }],
        paging: { cursors: { after: "cursor1" }, next: "https://x/next1" },
      },
      {
        data: [{ id: "cmp_2" }],
        paging: { cursors: { after: "cursor2" }, next: "https://x/next2" },
      },
      { data: [{ id: "cmp_3" }], paging: { cursors: { after: "cursor3" } } }, // no `next` -> stop
    ]);
    const result = await fetchAllCampaigns(client);
    expect(result.rows.map((r) => r.id)).toEqual(["cmp_1", "cmp_2", "cmp_3"]);
    expect(result.pages).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const secondCallUrl = new URL(fetchImpl.mock.calls[1][0] as string);
    expect(secondCallUrl.searchParams.get("after")).toBe("cursor1");
    const thirdCallUrl = new URL(fetchImpl.mock.calls[2][0] as string);
    expect(thirdCallUrl.searchParams.get("after")).toBe("cursor2");
  });

  it("stops when paging.next is present but cursors.after is missing (defensive)", async () => {
    const { client, fetchImpl } = clientWithSequence([
      { data: [{ id: "cmp_1" }], paging: { next: "https://x/next1" } },
    ]);
    const result = await fetchAllCampaigns(client);
    expect(result.rows).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("fetchAllAdsets / fetchAllAds / fetchAllCreatives", () => {
  it("fetchAllAdsets hits the adsets edge with the expected field list", async () => {
    const { client, fetchImpl } = clientWithSequence([{ data: [{ id: "as_1" }] }]);
    await fetchAllAdsets(client);
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.pathname).toContain("/adsets");
    expect(url.searchParams.get("fields")).toContain("daily_budget");
    expect(url.searchParams.get("fields")).toContain("targeting");
  });

  it("fetchAllAds hits the ads edge and requests only a light creative{id} sub-field", async () => {
    const { client, fetchImpl } = clientWithSequence([{ data: [{ id: "ad_1" }] }]);
    await fetchAllAds(client);
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.pathname).toContain("/ads");
    expect(url.searchParams.get("fields")).toContain("creative{id}");
  });

  it("fetchAllCreatives hits the adcreatives edge with a conservative page size", async () => {
    const { client, fetchImpl } = clientWithSequence([{ data: [{ id: "cr_1" }] }]);
    await fetchAllCreatives(client);
    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.pathname).toContain("/adcreatives");
    expect(url.searchParams.get("limit")).toBe("25");
  });
});
