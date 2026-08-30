import { describe, expect, it } from "vitest";
import { normalizeInsightsRow, type NormalizeInsightsRowCtx } from "./normalize.ts";

const ctx: NormalizeInsightsRowCtx = {
  accountId: "act_123",
  currency: "INR",
  attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
  fetchedAt: new Date("2026-08-30T12:00:00Z"),
};

describe("normalizeInsightsRow", () => {
  it("normalizes a full row, pulling the funnel actions and the pinned purchase action type", () => {
    const doc = normalizeInsightsRow(
      {
        ad_id: "ad_1",
        adset_id: "as_1",
        campaign_id: "cmp_1",
        date_start: "2026-08-15",
        date_stop: "2026-08-15",
        spend: "199.50",
        impressions: "1000",
        reach: "800",
        frequency: "1.25",
        clicks: "40",
        actions: [
          { action_type: "landing_page_view", value: "120" },
          { action_type: "add_to_cart", value: "10" },
          { action_type: "initiate_checkout", value: "4" },
          { action_type: "omni_purchase", value: "2" },
          { action_type: "link_click", value: "40" },
        ],
        action_values: [{ action_type: "omni_purchase", value: "3999.00" }],
      },
      ctx,
    );

    expect(doc).toEqual({
      adId: "ad_1",
      adsetId: "as_1",
      campaignId: "cmp_1",
      accountId: "act_123",
      date: "2026-08-15",
      attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
      spendMinorUnits: 19950,
      currency: "INR",
      impressions: 1000,
      reach: 800,
      frequency: 1.25,
      clicks: 40,
      landingPageViews: 120,
      addToCart: 10,
      initiateCheckout: 4,
      purchases: 2,
      purchaseValueMinorUnits: 399900,
      sourceUpdatedAt: ctx.fetchedAt,
      fetchedAt: ctx.fetchedAt,
    });
  });

  it("defaults missing numeric/action fields to zero rather than throwing (a genuine zero-activity day)", () => {
    const doc = normalizeInsightsRow(
      { ad_id: "ad_1", adset_id: "as_1", campaign_id: "cmp_1", date_start: "2026-08-15" },
      ctx,
    );
    expect(doc.spendMinorUnits).toBe(0);
    expect(doc.impressions).toBe(0);
    expect(doc.clicks).toBe(0);
    expect(doc.landingPageViews).toBe(0);
    expect(doc.addToCart).toBe(0);
    expect(doc.initiateCheckout).toBe(0);
    expect(doc.purchases).toBe(0);
    expect(doc.purchaseValueMinorUnits).toBe(0);
    expect(doc.reach).toBeNull();
    expect(doc.frequency).toBeNull();
  });

  it("throws when a required identifying field is missing", () => {
    expect(() =>
      normalizeInsightsRow(
        { adset_id: "as_1", campaign_id: "cmp_1", date_start: "2026-08-15" },
        ctx,
      ),
    ).toThrow(/missing a required identifying field/);
  });

  it("throws on a malformed date_start", () => {
    expect(() =>
      normalizeInsightsRow(
        { ad_id: "ad_1", adset_id: "as_1", campaign_id: "cmp_1", date_start: "15-08-2026" },
        ctx,
      ),
    ).toThrow();
  });

  it("stamps every row with the same attribution provenance and fetchedAt from ctx", () => {
    const rowA = normalizeInsightsRow(
      { ad_id: "ad_1", adset_id: "as_1", campaign_id: "cmp_1", date_start: "2026-08-15" },
      ctx,
    );
    const rowB = normalizeInsightsRow(
      { ad_id: "ad_2", adset_id: "as_1", campaign_id: "cmp_1", date_start: "2026-08-16" },
      ctx,
    );
    expect(rowA.attribution).toEqual(rowB.attribution);
    expect(rowA.sourceUpdatedAt).toBe(rowB.sourceUpdatedAt);
  });
});
