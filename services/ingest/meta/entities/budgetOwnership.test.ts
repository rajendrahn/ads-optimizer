import { describe, expect, it } from "vitest";
import {
  determineAdsetBudget,
  determineCampaignBudget,
  determineCampaignBudgetGivenChildren,
} from "./budgetOwnership.ts";

describe("determineCampaignBudget", () => {
  it("returns CAMPAIGN ownership when daily_budget is present", () => {
    const result = determineCampaignBudget({ daily_budget: "80000" }, "INR");
    expect(result).toEqual({
      ownerLevel: "CAMPAIGN",
      dailyBudgetMinorUnits: 80000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    });
  });

  it("returns CAMPAIGN ownership when only lifetime_budget is present", () => {
    const result = determineCampaignBudget({ lifetime_budget: "262000" }, "INR");
    expect(result).toEqual({
      ownerLevel: "CAMPAIGN",
      dailyBudgetMinorUnits: null,
      lifetimeBudgetMinorUnits: 262000,
      currency: "INR",
    });
  });

  it("returns null when the campaign reports no budget of its own", () => {
    expect(determineCampaignBudget({}, "INR")).toBeNull();
  });

  it("parses the budget as an already-minor-units integer, not a decimal string", () => {
    // Meta's own representation — confirmed live: "80000" means ₹800.00/day, not ₹80,000.00.
    const result = determineCampaignBudget({ daily_budget: "80000" }, "INR");
    expect(result?.dailyBudgetMinorUnits).toBe(80000);
  });

  it("throws on a non-integer budget string", () => {
    expect(() => determineCampaignBudget({ daily_budget: "80000.50" }, "INR")).toThrow(
      /integer minor-units string/,
    );
  });
});

describe("determineCampaignBudgetGivenChildren", () => {
  it("returns the campaign's own budget when it has one (CBO), regardless of ad sets", () => {
    const result = determineCampaignBudgetGivenChildren(
      { daily_budget: "80000" },
      [{ daily_budget: "5000" }], // a conflicting child is still just noise at this level
      "INR",
    );
    expect(result?.ownerLevel).toBe("CAMPAIGN");
  });

  it("returns null (ad-set level owns) when the campaign has none but an ad set does", () => {
    const result = determineCampaignBudgetGivenChildren({}, [{}, { daily_budget: "3000" }], "INR");
    expect(result).toBeNull();
  });

  it("returns UNKNOWN when the campaign has no budget and no ad sets at all", () => {
    // The exact live pattern observed on this account: 4 old PAUSED campaigns with zero ad
    // sets returned (their ad sets are permanently deleted) and no campaign-level budget.
    const result = determineCampaignBudgetGivenChildren({}, [], "INR");
    expect(result).toEqual({
      ownerLevel: "UNKNOWN",
      dailyBudgetMinorUnits: null,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    });
  });

  it("returns UNKNOWN when the campaign has ad sets but none of them report a budget either", () => {
    const result = determineCampaignBudgetGivenChildren({}, [{}, {}], "INR");
    expect(result?.ownerLevel).toBe("UNKNOWN");
  });
});

describe("determineAdsetBudget", () => {
  it("returns null when the campaign owns budget and the ad set reports none", () => {
    const result = determineAdsetBudget({
      adset: {},
      campaignOwnsBudget: true,
      currency: "INR",
    });
    expect(result).toBeNull();
  });

  it("returns ADSET ownership when the campaign doesn't own budget and the ad set does", () => {
    const result = determineAdsetBudget({
      adset: { daily_budget: "3000" },
      campaignOwnsBudget: false,
      currency: "INR",
    });
    expect(result).toEqual({
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: 3000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    });
  });

  it("returns UNKNOWN when both the campaign and the ad set report a budget (conflict)", () => {
    const result = determineAdsetBudget({
      adset: { daily_budget: "3000" },
      campaignOwnsBudget: true,
      currency: "INR",
    });
    expect(result?.ownerLevel).toBe("UNKNOWN");
  });

  it("returns UNKNOWN when neither the campaign nor the ad set reports a budget", () => {
    const result = determineAdsetBudget({
      adset: {},
      campaignOwnsBudget: false,
      currency: "INR",
    });
    expect(result?.ownerLevel).toBe("UNKNOWN");
  });
});
