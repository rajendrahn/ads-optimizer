import { describe, expect, it } from "vitest";
import { computeBlendedMer } from "./mer.ts";

describe("computeBlendedMer", () => {
  it("total Shopify revenue / total Meta spend, using no attribution at all", () => {
    const result = computeBlendedMer({
      totalShopifyRevenueMinorUnits: 500_000_00, // ₹5,00,000
      totalMetaSpendMinorUnits: 100_000_00, // ₹1,00,000
    });
    expect(result).toBeCloseTo(5);
  });

  it("null (undefined), not Infinity, when there was no Meta spend", () => {
    expect(
      computeBlendedMer({ totalShopifyRevenueMinorUnits: 100_00, totalMetaSpendMinorUnits: 0 }),
    ).toBeNull();
  });

  it("zero Shopify revenue against real spend is a real 0, not null", () => {
    expect(
      computeBlendedMer({ totalShopifyRevenueMinorUnits: 0, totalMetaSpendMinorUnits: 100_00 }),
    ).toBe(0);
  });
});
