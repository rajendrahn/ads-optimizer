import { describe, expect, it } from "vitest";
import { computeAttributionCoverageRatio, tallyResolvedOrders } from "./coverage.ts";

describe("tallyResolvedOrders", () => {
  it("tallies by method", () => {
    const result = tallyResolvedOrders([
      { resolutionMethod: "AD_ID" },
      { resolutionMethod: "AD_ID" },
      { resolutionMethod: "NAME_MATCH" },
      { resolutionMethod: "UNRESOLVED" },
      { resolutionMethod: "UNRESOLVED" },
      { resolutionMethod: "UNRESOLVED" },
    ]);
    expect(result).toEqual({ idResolved: 2, nameResolved: 1, unresolved: 3, total: 6 });
  });

  it("empty input", () => {
    expect(tallyResolvedOrders([])).toEqual({
      idResolved: 0,
      nameResolved: 0,
      unresolved: 0,
      total: 0,
    });
  });
});

describe("computeAttributionCoverageRatio", () => {
  it("coverageRatio uses ID-resolved purchases only — never pooled with NAME_MATCH", () => {
    const result = computeAttributionCoverageRatio({
      shopifyAttributedPurchasesIdOnly: 10,
      shopifyAttributedPurchasesNameMatch: 5,
      metaReportedPurchases: 100,
    });
    expect(result.coverageRatio).toBeCloseTo(0.1);
    expect(result.coverageRatioIncludingNameMatch).toBeCloseTo(0.15);
    expect(result.coverageRatio).not.toBeNull();
    expect(result.coverageRatioIncludingNameMatch).toBeGreaterThan(result.coverageRatio as number);
    expect(result.shopifyAttributedPurchasesIncludingNameMatch).toBe(15);
  });

  it("realistic near-zero coverage (Open Question #1: 2 orders in 10,001)", () => {
    const result = computeAttributionCoverageRatio({
      shopifyAttributedPurchasesIdOnly: 2,
      shopifyAttributedPurchasesNameMatch: 48,
      metaReportedPurchases: 6000, // ~600/month over ~10 months, §2.1's estimate
    });
    expect(result.coverageRatio).toBeCloseTo(2 / 6000);
    expect(result.coverageRatio).toBeLessThan(0.001);
  });

  it("undefined (null), not zero or infinite, when Meta reports no purchases at all", () => {
    const result = computeAttributionCoverageRatio({
      shopifyAttributedPurchasesIdOnly: 0,
      shopifyAttributedPurchasesNameMatch: 0,
      metaReportedPurchases: 0,
    });
    expect(result.coverageRatio).toBeNull();
    expect(result.coverageRatioIncludingNameMatch).toBeNull();
  });

  it("zero Shopify-attributed purchases against real Meta spend is a real ratio of 0, not null", () => {
    const result = computeAttributionCoverageRatio({
      shopifyAttributedPurchasesIdOnly: 0,
      shopifyAttributedPurchasesNameMatch: 0,
      metaReportedPurchases: 50,
    });
    expect(result.coverageRatio).toBe(0);
  });
});
