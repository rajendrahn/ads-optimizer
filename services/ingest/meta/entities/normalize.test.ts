import { describe, expect, it } from "vitest";
import {
  normalizeAd,
  normalizeAdset,
  normalizeCampaign,
  normalizeCreative,
  type RawMetaAd,
  type RawMetaAdset,
  type RawMetaCampaign,
  type RawMetaCreative,
} from "./normalize.ts";

const CTX = { accountId: "act_test", currency: "INR", syncedAt: new Date("2026-08-30T00:00:00Z") };

describe("normalizeCampaign", () => {
  const base: RawMetaCampaign = {
    id: "cmp_1",
    name: "Sales I CBO I open target",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    buying_type: "AUCTION",
    daily_budget: "80000",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    created_time: "2026-08-26T13:33:12+0530",
    updated_time: "2026-08-26T13:33:12+0530",
  };

  it("maps a CBO campaign's fields, including campaign-owned budget", () => {
    const result = normalizeCampaign(base, [], CTX);
    expect(result).toEqual({
      campaignId: "cmp_1",
      accountId: "act_test",
      name: "Sales I CBO I open target",
      status: "ACTIVE",
      objective: "OUTCOME_SALES",
      buyingType: "AUCTION",
      budget: {
        ownerLevel: "CAMPAIGN",
        dailyBudgetMinorUnits: 80000,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      createdAt: new Date("2026-08-26T13:33:12+0530"),
      metaUpdatedAt: new Date("2026-08-26T13:33:12+0530"),
      syncedAt: CTX.syncedAt,
    });
  });

  it("nulls objective/buying_type/bid_strategy when Meta omits them, and defers budget to child ad sets", () => {
    const raw: RawMetaCampaign = {
      id: "cmp_2",
      name: "ABO campaign",
      status: "PAUSED",
      created_time: "2026-01-01T00:00:00+0530",
      updated_time: "2026-01-01T00:00:00+0530",
    };
    const result = normalizeCampaign(raw, [{ daily_budget: "3000" }], CTX);
    expect(result.objective).toBeNull();
    expect(result.buyingType).toBeNull();
    expect(result.bidStrategy).toBeNull();
    expect(result.budget).toBeNull(); // ad-set level owns it
  });

  it("marks budget UNKNOWN for a campaign with no budget and no ad sets (the live orphan pattern)", () => {
    const raw: RawMetaCampaign = {
      id: "cmp_orphan",
      name: "Sales",
      status: "PAUSED",
      created_time: "2025-08-16T16:33:18+0530",
      updated_time: "2025-08-16T20:58:07+0530",
    };
    const result = normalizeCampaign(raw, [], CTX);
    expect(result.budget?.ownerLevel).toBe("UNKNOWN");
  });
});

describe("normalizeAdset", () => {
  const base: RawMetaAdset = {
    id: "as_1",
    campaign_id: "cmp_2",
    name: "ABO ad set",
    status: "ACTIVE",
    daily_budget: "3000",
    optimization_goal: "OFFSITE_CONVERSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: {
      publisher_platforms: ["instagram", "facebook"],
      geo_locations: { countries: ["IN"] },
    },
    created_time: "2026-01-01T00:00:00+0530",
    updated_time: "2026-01-02T00:00:00+0530",
  };

  it("maps fields, derives placements from targeting.publisher_platforms, and leaves attribution null", () => {
    const result = normalizeAdset(base, false, CTX);
    expect(result.adsetId).toBe("as_1");
    expect(result.campaignId).toBe("cmp_2");
    expect(result.budget).toEqual({
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: 3000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    });
    expect(result.placements).toEqual(["instagram", "facebook"]);
    expect(result.targeting).toEqual(base.targeting);
    expect(result.attribution).toBeNull();
  });

  it("nulls placements when targeting has no publisher_platforms array", () => {
    const raw: RawMetaAdset = { ...base, targeting: { geo_locations: { countries: ["IN"] } } };
    const result = normalizeAdset(raw, false, CTX);
    expect(result.placements).toBeNull();
  });

  it("nulls placements and targeting when Meta returns no targeting at all", () => {
    const raw: RawMetaAdset = { ...base, targeting: null };
    const result = normalizeAdset(raw, false, CTX);
    expect(result.placements).toBeNull();
    expect(result.targeting).toBeNull();
  });

  it("does not own budget when the parent campaign already owns it (CBO), even if Meta echoes a value", () => {
    const result = normalizeAdset(base, true, CTX);
    // campaignOwnsBudget=true and this ad set also reports one -> conflict -> UNKNOWN, not
    // silently CAMPAIGN's decision re-asserted as ADSET.
    expect(result.budget?.ownerLevel).toBe("UNKNOWN");
  });
});

describe("normalizeAd", () => {
  const base: RawMetaAd = {
    id: "ad_1",
    adset_id: "as_1",
    campaign_id: "cmp_1",
    name: "Ad 1",
    status: "ACTIVE",
    creative: { id: "cr_1" },
    created_time: "2026-01-01T00:00:00+0530",
    updated_time: "2026-01-02T00:00:00+0530",
  };

  it("derives destinationUrl from the matching creative's linkUrl", () => {
    const creativeLinkUrlById = new Map([["cr_1", "https://sparkleandglow.co.in/?utm_campaign=1"]]);
    const result = normalizeAd(base, {
      accountId: "act_test",
      syncedAt: CTX.syncedAt,
      creativeLinkUrlById,
    });
    expect(result.creativeId).toBe("cr_1");
    expect(result.destinationUrl).toBe("https://sparkleandglow.co.in/?utm_campaign=1");
  });

  it("nulls creativeId and destinationUrl when the ad has no creative", () => {
    const raw: RawMetaAd = { ...base, creative: null };
    const result = normalizeAd(raw, {
      accountId: "act_test",
      syncedAt: CTX.syncedAt,
      creativeLinkUrlById: new Map(),
    });
    expect(result.creativeId).toBeNull();
    expect(result.destinationUrl).toBeNull();
  });

  it("nulls destinationUrl when the assigned creative wasn't found in this run's creative fetch", () => {
    const result = normalizeAd(base, {
      accountId: "act_test",
      syncedAt: CTX.syncedAt,
      creativeLinkUrlById: new Map(),
    });
    expect(result.destinationUrl).toBeNull();
  });
});

describe("normalizeCreative", () => {
  it("classifies a plain image creative as STANDARD with no member hashes", () => {
    const raw: RawMetaCreative = {
      id: "cr_1",
      name: "Standard creative",
      image_hash: "hash1",
      object_story_spec: {
        link_data: { link: "https://example.com", message: "body", name: "headline" },
      },
    };
    const result = normalizeCreative(raw, { accountId: "act_test", syncedAt: CTX.syncedAt });
    expect(result.creativeType).toBe("STANDARD");
    expect(result.memberAssetHashes).toBeNull();
    expect(result.deliveredMixObservable).toBeNull();
    expect(result.imageHash).toBe("hash1");
    expect(result.linkUrl).toBe("https://example.com");
    expect(result.bodyText).toBe("body");
    expect(result.headline).toBe("headline");
  });

  it("classifies a creative with asset_feed_spec as COMPOSITE, non-observable, and never eligible for a fatigue score", () => {
    const raw: RawMetaCreative = {
      id: "cr_2",
      asset_feed_spec: { images: [{ hash: "a1" }, { hash: "b2" }] },
    };
    const result = normalizeCreative(raw, { accountId: "act_test", syncedAt: CTX.syncedAt });
    expect(result.creativeType).toBe("COMPOSITE");
    expect(result.deliveredMixObservable).toBe(false);
    expect(result.memberAssetHashes).toEqual(["a1", "b2"]);
  });

  it("collects member hashes from carousel child_attachments too (the live composite shape observed)", () => {
    const raw: RawMetaCreative = {
      id: "cr_3",
      asset_feed_spec: { bodies: undefined } as unknown as RawMetaCreative["asset_feed_spec"],
      object_story_spec: {
        link_data: {
          child_attachments: [{ image_hash: "x1" }, { image_hash: "x2" }, { video_id: "v1" }],
        },
      },
    };
    const result = normalizeCreative(raw, { accountId: "act_test", syncedAt: CTX.syncedAt });
    expect(result.creativeType).toBe("COMPOSITE");
    expect(result.memberAssetHashes).toEqual(["x1", "x2", "v1"]);
  });

  it("falls back to top-level body/title/link_url when object_story_spec is absent", () => {
    const raw: RawMetaCreative = {
      id: "cr_4",
      body: "top level body",
      title: "top level title",
      link_url: "https://example.com/top",
    };
    const result = normalizeCreative(raw, { accountId: "act_test", syncedAt: CTX.syncedAt });
    expect(result.bodyText).toBe("top level body");
    expect(result.headline).toBe("top level title");
    expect(result.linkUrl).toBe("https://example.com/top");
  });

  it("nulls everything derivable when Meta gives nothing to derive it from", () => {
    const raw: RawMetaCreative = { id: "cr_5" };
    const result = normalizeCreative(raw, { accountId: "act_test", syncedAt: CTX.syncedAt });
    expect(result.creativeType).toBe("STANDARD");
    expect(result.imageHash).toBeNull();
    expect(result.videoId).toBeNull();
    expect(result.bodyText).toBeNull();
    expect(result.headline).toBeNull();
    expect(result.linkUrl).toBeNull();
  });
});
