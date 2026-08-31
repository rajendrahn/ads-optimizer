import { describe, expect, it } from "vitest";
import type { BudgetOwnership, MetaAd, MetaAdset, MetaCampaign } from "@shared/schema/index.ts";
import { resolveDecisionUnit, type ChildAdsetBudget } from "./budgetOwnerResolution.ts";

const now = new Date("2026-08-30T00:00:00Z");

function owning(ownerLevel: "CAMPAIGN" | "ADSET" | "UNKNOWN"): BudgetOwnership {
  return {
    ownerLevel,
    dailyBudgetMinorUnits: 50000,
    lifetimeBudgetMinorUnits: null,
    currency: "INR",
  };
}

function campaign(overrides: Partial<MetaCampaign> = {}): MetaCampaign {
  return {
    campaignId: "cmp_1",
    accountId: "act_1",
    name: "Campaign 1",
    status: "ACTIVE",
    objective: null,
    buyingType: null,
    budget: null,
    bidStrategy: null,
    createdAt: now,
    metaUpdatedAt: now,
    syncedAt: now,
    ...overrides,
  };
}

function adset(overrides: Partial<MetaAdset> = {}): MetaAdset {
  return {
    adsetId: "as_1",
    campaignId: "cmp_1",
    accountId: "act_1",
    name: "Ad set 1",
    status: "ACTIVE",
    budget: null,
    optimizationGoal: null,
    bidStrategy: null,
    targeting: null,
    placements: null,
    attribution: null,
    createdAt: now,
    metaUpdatedAt: now,
    syncedAt: now,
    ...overrides,
  };
}

function ad(overrides: Partial<MetaAd> = {}): MetaAd {
  return {
    adId: "ad_1",
    adsetId: "as_1",
    campaignId: "cmp_1",
    accountId: "act_1",
    creativeId: null,
    name: "Ad 1",
    status: "ACTIVE",
    destinationUrl: null,
    createdAt: now,
    metaUpdatedAt: now,
    syncedAt: now,
    ...overrides,
  };
}

describe("resolveDecisionUnit — CAMPAIGN named entity", () => {
  it("resolves to itself when the campaign owns budget", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "CAMPAIGN", id: "cmp_1" },
      campaign: campaign({ budget: owning("CAMPAIGN") }),
    });
    expect(result).toEqual({ kind: "RESOLVED", decisionUnit: { type: "CAMPAIGN", id: "cmp_1" } });
  });

  it("reports NO_DECISION_UNIT when the campaign's own budget is UNKNOWN", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "CAMPAIGN", id: "cmp_orphan" },
      campaign: campaign({ campaignId: "cmp_orphan", budget: owning("UNKNOWN") }),
    });
    expect(result.kind).toBe("NO_DECISION_UNIT");
  });

  it("reports NO_DECISION_UNIT when the campaign is not found at all", () => {
    const result = resolveDecisionUnit({ namedEntity: { type: "CAMPAIGN", id: "cmp_missing" } });
    expect(result.kind).toBe("NO_DECISION_UNIT");
  });

  it("defers to the single ad set that owns budget when the campaign itself does not", () => {
    const childAdsetBudgets: ChildAdsetBudget[] = [
      { adsetId: "as_owner", budget: owning("ADSET") },
    ];
    const result = resolveDecisionUnit({
      namedEntity: { type: "CAMPAIGN", id: "cmp_1" },
      campaign: campaign({ budget: null }),
      childAdsetBudgets,
    });
    expect(result).toEqual({ kind: "RESOLVED", decisionUnit: { type: "ADSET", id: "as_owner" } });
  });

  it("reports NO_DECISION_UNIT when no child ad set owns budget either", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "CAMPAIGN", id: "cmp_1" },
      campaign: campaign({ budget: null }),
      childAdsetBudgets: [{ adsetId: "as_1", budget: null }],
    });
    expect(result.kind).toBe("NO_DECISION_UNIT");
  });

  it("reports NO_DECISION_UNIT when MULTIPLE child ad sets independently own budget (ABO)", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "CAMPAIGN", id: "cmp_1" },
      campaign: campaign({ budget: null }),
      childAdsetBudgets: [
        { adsetId: "as_a", budget: owning("ADSET") },
        { adsetId: "as_b", budget: owning("ADSET") },
      ],
    });
    expect(result.kind).toBe("NO_DECISION_UNIT");
    if (result.kind === "NO_DECISION_UNIT") {
      expect(result.detail).toContain("as_a");
      expect(result.detail).toContain("as_b");
    }
  });
});

describe("resolveDecisionUnit — ADSET named entity", () => {
  it("resolves to itself when the campaign defers and this ad set owns budget", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "ADSET", id: "as_1" },
      adset: adset({ budget: owning("ADSET") }),
      campaign: campaign({ budget: null }),
    });
    expect(result).toEqual({ kind: "RESOLVED", decisionUnit: { type: "ADSET", id: "as_1" } });
  });

  it("escalates to the campaign when the campaign owns budget (CBO)", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "ADSET", id: "as_1" },
      adset: adset({ budget: null }),
      campaign: campaign({ budget: owning("CAMPAIGN") }),
    });
    expect(result).toEqual({
      kind: "RESOLVED",
      decisionUnit: { type: "CAMPAIGN", id: "cmp_1" },
      escalatedFrom: { type: "ADSET", id: "as_1", reason: "ADSET_NOT_BUDGET_OWNER" },
    });
  });

  it("reports NO_DECISION_UNIT when the campaign defers but the ad set's own budget is UNKNOWN", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "ADSET", id: "as_1" },
      adset: adset({ budget: owning("UNKNOWN") }),
      campaign: campaign({ budget: null }),
    });
    expect(result.kind).toBe("NO_DECISION_UNIT");
  });
});

describe("resolveDecisionUnit — AD named entity (always escalates)", () => {
  it("escalates to its ad set with reason SAMPLE_TOO_SMALL when its own volume is below the floor", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "AD", id: "ad_low_volume" },
      ad: ad({ adId: "ad_low_volume", adsetId: "as_1" }),
      adset: adset({ budget: owning("ADSET") }),
      campaign: campaign({ budget: null }),
      adPrimaryWindowSampleSize: 6,
      adPrimaryWindowMinPurchaseFloor: 30,
    });
    expect(result).toEqual({
      kind: "RESOLVED",
      decisionUnit: { type: "ADSET", id: "as_1" },
      escalatedFrom: { type: "AD", id: "ad_low_volume", reason: "SAMPLE_TOO_SMALL" },
    });
  });

  it("escalates with reason AD_NOT_BUDGET_OWNER when its own volume already clears the floor", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "AD", id: "ad_healthy" },
      ad: ad({ adId: "ad_healthy", adsetId: "as_1" }),
      adset: adset({ budget: owning("ADSET") }),
      campaign: campaign({ budget: null }),
      adPrimaryWindowSampleSize: 120,
      adPrimaryWindowMinPurchaseFloor: 30,
    });
    expect(result).toEqual({
      kind: "RESOLVED",
      decisionUnit: { type: "ADSET", id: "as_1" },
      escalatedFrom: { type: "AD", id: "ad_healthy", reason: "AD_NOT_BUDGET_OWNER" },
    });
  });

  it("falls back to AD_NOT_BUDGET_OWNER when the ad's own volume is unknown", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "AD", id: "ad_new" },
      ad: ad({ adId: "ad_new", adsetId: "as_1" }),
      adset: adset({ budget: owning("ADSET") }),
      campaign: campaign({ budget: null }),
    });
    expect(result).toEqual({
      kind: "RESOLVED",
      decisionUnit: { type: "ADSET", id: "as_1" },
      escalatedFrom: { type: "AD", id: "ad_new", reason: "AD_NOT_BUDGET_OWNER" },
    });
  });

  it("still escalates all the way to the campaign when CBO is in effect", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "AD", id: "ad_1" },
      ad: ad({ adId: "ad_1" }),
      adset: adset({ budget: null }),
      campaign: campaign({ budget: owning("CAMPAIGN") }),
      adPrimaryWindowSampleSize: 5,
      adPrimaryWindowMinPurchaseFloor: 30,
    });
    expect(result).toEqual({
      kind: "RESOLVED",
      decisionUnit: { type: "CAMPAIGN", id: "cmp_1" },
      escalatedFrom: { type: "AD", id: "ad_1", reason: "SAMPLE_TOO_SMALL" },
    });
  });

  it("reports NO_DECISION_UNIT when the ad's own chain is genuinely UNKNOWN", () => {
    const result = resolveDecisionUnit({
      namedEntity: { type: "AD", id: "ad_1" },
      ad: ad({ adId: "ad_1" }),
      adset: adset({ budget: owning("UNKNOWN") }),
      campaign: campaign({ budget: null }),
    });
    expect(result.kind).toBe("NO_DECISION_UNIT");
  });

  it("reports NO_DECISION_UNIT when the ad's chain could not be loaded at all", () => {
    const result = resolveDecisionUnit({ namedEntity: { type: "AD", id: "ad_ghost" } });
    expect(result.kind).toBe("NO_DECISION_UNIT");
  });
});
