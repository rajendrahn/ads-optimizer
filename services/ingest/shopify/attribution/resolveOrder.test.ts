import { describe, expect, it } from "vitest";
import {
  AD_ID_CONFIDENCE,
  NAME_MATCH_CONFIDENCE,
  buildAttributionIndexFromEntities,
  resolveOrderAttribution,
} from "./resolveOrder.ts";

const ads = [
  { adId: "120210000000003", campaignId: "120210000000001", name: "RM_Instagram" },
  { adId: "120210000000004", campaignId: "120210000000001", name: "Navratri sale 15% OFF| AD" },
  // A deliberate name collision — two different ads sharing a normalized name.
  { adId: "999000000000001", campaignId: "120210000000002", name: "Retarget - 7d" },
  { adId: "999000000000002", campaignId: "120210000000002", name: "Retarget - 7d" },
];
const campaigns = [
  { campaignId: "120210000000001", name: "New Sales Ad Set" },
  { campaignId: "120210000000002", name: "RM_CBO_Remarketing_Campaign" },
];
const index = buildAttributionIndexFromEntities(ads, campaigns);

function landingSite(query: string): string {
  return `/products/x?${query}`;
}

describe("resolveOrderAttribution — AD_ID path", () => {
  it("resolves a numeric utm_content that matches a known ad — the intended §6.1 join", () => {
    const result = resolveOrderAttribution(
      landingSite("utm_source=meta&utm_content=120210000000003"),
      index,
    );
    expect(result.resolutionMethod).toBe("AD_ID");
    expect(result.resolvedAdId).toBe("120210000000003");
    expect(result.resolvedCampaignId).toBe("120210000000001"); // the ad's own campaign
    expect(result.resolutionConfidence).toBe(AD_ID_CONFIDENCE);
    expect(result.ambiguousNameCandidateIds).toBeNull();
    expect(result.rawAttributionTag).toBe("utm_source=meta&utm_content=120210000000003");
  });

  it("falls back to a numeric utm_campaign matching a known campaign (coarser AD_ID)", () => {
    const result = resolveOrderAttribution(
      landingSite("utm_source=meta&utm_campaign=120210000000002"),
      index,
    );
    expect(result.resolutionMethod).toBe("AD_ID");
    expect(result.resolvedAdId).toBeNull();
    expect(result.resolvedCampaignId).toBe("120210000000002");
    expect(result.resolutionConfidence).toBe(AD_ID_CONFIDENCE);
  });

  it("a numeric utm_content that matches NO known ad does not resolve as AD_ID", () => {
    const result = resolveOrderAttribution(
      landingSite("utm_source=meta&utm_content=000000000000000"),
      index,
    );
    expect(result.resolutionMethod).toBe("UNRESOLVED");
  });
});

describe("resolveOrderAttribution — NAME_MATCH path", () => {
  it("resolves a unique ad-name utm_content, with lower confidence than AD_ID", () => {
    const result = resolveOrderAttribution(
      landingSite("utm_source=roi_meta&utm_content=RM_Instagram"),
      index,
    );
    expect(result.resolutionMethod).toBe("NAME_MATCH");
    expect(result.resolvedAdId).toBe("120210000000003");
    expect(result.resolvedCampaignId).toBe("120210000000001");
    expect(result.resolutionConfidence).toBe(NAME_MATCH_CONFIDENCE);
    expect(result.resolutionConfidence).toBeLessThan(AD_ID_CONFIDENCE);
  });

  it("resolves a real Open Question #1 example with special characters and URL encoding", () => {
    const result = resolveOrderAttribution(
      landingSite("utm_source=RM_META&utm_content=Navratri%20sale%2015%25%20OFF%7C%20AD"),
      index,
    );
    expect(result.resolutionMethod).toBe("NAME_MATCH");
    expect(result.resolvedAdId).toBe("120210000000004");
  });

  it("falls back to campaign-name match when utm_content doesn't match any ad name", () => {
    const result = resolveOrderAttribution(
      landingSite("utm_source=meta&utm_content=New%20Sales%20Ad%20Set"),
      index,
    );
    expect(result.resolutionMethod).toBe("NAME_MATCH");
    expect(result.resolvedAdId).toBeNull();
    expect(result.resolvedCampaignId).toBe("120210000000001");
  });

  it("falls back to utm_campaign against campaign names when utm_content matches nothing", () => {
    const result = resolveOrderAttribution(
      landingSite("utm_source=meta&utm_campaign=RM_CBO_Remarketing_Campaign"),
      index,
    );
    expect(result.resolutionMethod).toBe("NAME_MATCH");
    expect(result.resolvedCampaignId).toBe("120210000000002");
  });

  it("an ambiguous name (two ads sharing it) is UNRESOLVED, never guessed", () => {
    const result = resolveOrderAttribution(
      landingSite("utm_source=meta&utm_content=Retarget%20-%207d"),
      index,
    );
    expect(result.resolutionMethod).toBe("UNRESOLVED");
    expect(result.resolvedAdId).toBeNull();
    expect(result.ambiguousNameCandidateIds?.sort()).toEqual([
      "999000000000001",
      "999000000000002",
    ]);
    // the raw tag is still preserved even when unresolved, for replay/audit purposes
    expect(result.rawAttributionTag).toContain("utm_content=Retarget");
  });
});

describe("resolveOrderAttribution — UNRESOLVED path", () => {
  it("no landingSite at all", () => {
    const result = resolveOrderAttribution(null, index);
    expect(result).toEqual({
      rawAttributionTag: null,
      resolvedAdId: null,
      resolvedCampaignId: null,
      resolutionMethod: "UNRESOLVED",
      resolutionConfidence: null,
      ambiguousNameCandidateIds: null,
    });
  });

  it("a landingSite with no query string at all", () => {
    const result = resolveOrderAttribution("/products/x", index);
    expect(result.resolutionMethod).toBe("UNRESOLVED");
    expect(result.rawAttributionTag).toBeNull();
  });

  it("fbclid-only — opaque, cannot resolve to an ad (Open Question #1: 97 orders)", () => {
    const result = resolveOrderAttribution(landingSite("fbclid=IwAR123abc"), index);
    expect(result.resolutionMethod).toBe("UNRESOLVED");
    expect(result.resolvedAdId).toBeNull();
    // still captured verbatim for replay, even though it can't resolve
    expect(result.rawAttributionTag).toBe("fbclid=IwAR123abc");
  });

  it("a non-Meta utm_source is never matched, even if utm_content coincidentally matches an ad name", () => {
    const result = resolveOrderAttribution(
      landingSite("utm_source=google&utm_content=RM_Instagram"),
      index,
    );
    expect(result.resolutionMethod).toBe("UNRESOLVED");
    expect(result.resolvedAdId).toBeNull();
  });

  it("no utm_source at all is never matched either, even with a real-looking utm_content", () => {
    const result = resolveOrderAttribution(landingSite("utm_content=RM_Instagram"), index);
    expect(result.resolutionMethod).toBe("UNRESOLVED");
  });

  it("a recognized Meta source with utm_content matching nothing at all", () => {
    const result = resolveOrderAttribution(
      landingSite("utm_source=meta&utm_content=some_unrelated_string"),
      index,
    );
    expect(result.resolutionMethod).toBe("UNRESOLVED");
    expect(result.resolvedAdId).toBeNull();
    expect(result.resolvedCampaignId).toBeNull();
  });
});
