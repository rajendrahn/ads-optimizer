import { describe, expect, it, vi } from "vitest";
import { META_AD_ACCOUNT_ID } from "../../../../scripts/config.ts";
import { MetaClient } from "../client.ts";
import { fetchAllMetaEntities } from "./fetchAll.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchAllMetaEntities", () => {
  it("fetches currency, campaigns, adsets, ads, creatives in that order and groups adsets by campaign", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(url as string);
      calls.push(u.pathname);
      if (u.pathname.endsWith(`/${META_AD_ACCOUNT_ID}`)) return jsonResponse({ currency: "INR" });
      if (u.pathname.endsWith("/campaigns"))
        return jsonResponse({ data: [{ id: "cmp_1" }, { id: "cmp_2" }] });
      if (u.pathname.endsWith("/adsets")) {
        return jsonResponse({
          data: [
            { id: "as_1", campaign_id: "cmp_1" },
            { id: "as_2", campaign_id: "cmp_1" },
            { id: "as_3", campaign_id: "cmp_2" },
          ],
        });
      }
      if (u.pathname.endsWith("/ads")) return jsonResponse({ data: [{ id: "ad_1" }] });
      if (u.pathname.endsWith("/adcreatives")) return jsonResponse({ data: [{ id: "cr_1" }] });
      throw new Error(`unexpected path ${u.pathname}`);
    });
    const client = new MetaClient({
      accessToken: "tok",
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
    });

    const result = await fetchAllMetaEntities(client);

    expect(result.currency).toBe("INR");
    expect(result.campaigns.rows).toHaveLength(2);
    expect(result.adsets.rows).toHaveLength(3);
    expect(result.ads.rows).toHaveLength(1);
    expect(result.creatives.rows).toHaveLength(1);
    expect(result.adsetsByCampaignId.get("cmp_1")).toHaveLength(2);
    expect(result.adsetsByCampaignId.get("cmp_2")).toHaveLength(1);
    expect(result.adsetsByCampaignId.get("cmp_missing")).toBeUndefined();

    // Sequential, not parallel: currency, then campaigns, adsets, ads, creatives — in order.
    expect(calls).toHaveLength(5);
    expect(calls[0].endsWith(`/${META_AD_ACCOUNT_ID}`)).toBe(true);
    expect(calls[1].endsWith("/campaigns")).toBe(true);
    expect(calls[2].endsWith("/adsets")).toBe(true);
    expect(calls[3].endsWith("/ads")).toBe(true);
    expect(calls[4].endsWith("/adcreatives")).toBe(true);
  });
});
