import { describe, expect, it } from "vitest";
import type {
  CreativeAsset,
  CreativeFamily,
  MetaAd,
  MetaAdset,
  MetaCampaign,
  MetaCreative,
} from "@shared/schema/index.ts";
import { buildEntityGraph } from "./entityGraph.ts";

const NOW = new Date("2026-08-31T00:00:00Z");

function ad(
  overrides: Partial<MetaAd> & { adId: string; adsetId: string; campaignId: string },
): MetaAd {
  return {
    accountId: "act_1",
    creativeId: null,
    name: "ad",
    status: "ACTIVE",
    destinationUrl: null,
    createdAt: NOW,
    metaUpdatedAt: NOW,
    syncedAt: NOW,
    ...overrides,
  };
}

describe("buildEntityGraph", () => {
  const campaigns: MetaCampaign[] = [
    {
      campaignId: "c1",
      accountId: "act_1",
      name: "Campaign 1",
      status: "ACTIVE",
      objective: null,
      buyingType: null,
      budget: null,
      bidStrategy: null,
      createdAt: NOW,
      metaUpdatedAt: NOW,
      syncedAt: NOW,
    },
  ];
  const adsets: MetaAdset[] = [
    {
      adsetId: "as1",
      campaignId: "c1",
      accountId: "act_1",
      name: "Adset 1",
      status: "ACTIVE",
      budget: null,
      optimizationGoal: null,
      bidStrategy: null,
      targeting: null,
      placements: null,
      attribution: null,
      createdAt: NOW,
      metaUpdatedAt: NOW,
      syncedAt: NOW,
    },
  ];
  const creatives: MetaCreative[] = [
    {
      creativeId: "cr_standard",
      accountId: "act_1",
      name: null,
      imageHash: "hash_abc",
      videoId: null,
      creativeType: "STANDARD",
      memberAssetHashes: null,
      deliveredMixObservable: null,
      bodyText: null,
      headline: null,
      linkUrl: null,
      syncedAt: NOW,
    },
    {
      creativeId: "cr_composite",
      accountId: "act_1",
      name: null,
      imageHash: null,
      videoId: null,
      creativeType: "COMPOSITE",
      memberAssetHashes: ["hash_a", "hash_b"],
      deliveredMixObservable: false,
      bodyText: null,
      headline: null,
      linkUrl: null,
      syncedAt: NOW,
    },
  ];
  const assets: CreativeAsset[] = [
    {
      assetHash: "hash_abc",
      sourceType: "IMAGE",
      metaImageHash: "hash_abc",
      metaVideoId: null,
      perceptualHash: null,
      cloudStoragePath: null,
      thumbnailUrl: null,
      copy: null,
      ocrText: null,
      transcript: null,
      structuredTags: null,
      embedding: null,
      familyId: "hash_abc",
      analysisTimestamp: null,
      analysisModelVersion: null,
      discoveredAt: NOW,
    },
  ];
  const families: CreativeFamily[] = [
    {
      familyId: "hash_abc",
      memberAssetHashes: ["hash_abc"],
      creativeType: "STANDARD",
      eligibleForFamilyFatigueScore: true,
      familyAgeDays: null,
      totalHistoricalSpendMinorUnits: null,
      activeAdsCount: null,
      variationCount: 1,
      fatigueScore: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];

  it("maps an ad to its adset/campaign directly from metaAds", () => {
    const ads = [ad({ adId: "a1", adsetId: "as1", campaignId: "c1" })];
    const graph = buildEntityGraph({ ads, adsets, campaigns, creatives, assets, families });
    expect(graph.adsetByAd.get("a1")).toBe("as1");
    expect(graph.campaignByAd.get("a1")).toBe("c1");
    expect(graph.campaignByAdset.get("as1")).toBe("c1");
    expect(graph.adsByAdset.get("as1")).toEqual(["a1"]);
  });

  it("resolves a STANDARD-creative ad to its family via creativeAssets.familyId", () => {
    const ads = [ad({ adId: "a1", adsetId: "as1", campaignId: "c1", creativeId: "cr_standard" })];
    const graph = buildEntityGraph({ ads, adsets, campaigns, creatives, assets, families });
    expect(graph.familyByAd.get("a1")).toBe("hash_abc");
    expect(graph.adsByFamily.get("hash_abc")).toEqual(["a1"]);
  });

  it("resolves a COMPOSITE-creative ad to composite_{creativeId}, reusing B8's own scheme", () => {
    const ads = [ad({ adId: "a2", adsetId: "as1", campaignId: "c1", creativeId: "cr_composite" })];
    const graph = buildEntityGraph({ ads, adsets, campaigns, creatives, assets, families });
    expect(graph.familyByAd.get("a2")).toBe("composite_cr_composite");
  });

  it("an ad with no creativeId, or a creative with no honest asset hash, maps to null — never fabricated", () => {
    const ads = [ad({ adId: "a3", adsetId: "as1", campaignId: "c1", creativeId: null })];
    const graph = buildEntityGraph({ ads, adsets, campaigns, creatives, assets, families });
    expect(graph.familyByAd.get("a3")).toBeNull();
  });
});
