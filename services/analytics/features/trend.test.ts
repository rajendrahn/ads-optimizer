import { describe, expect, it } from "vitest";
import type { MetaWindowTotals } from "./metaWindowAggregate.ts";
import { computeTrend } from "./trend.ts";

function totals(overrides: Partial<MetaWindowTotals>): MetaWindowTotals {
  return {
    currency: "INR",
    attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
    spendMinorUnits: 700_00,
    impressions: 10000,
    reach: 8000,
    clicks: 500,
    landingPageViews: 400,
    addToCart: 40,
    initiateCheckout: 20,
    purchases: 10,
    purchaseValueMinorUnits: 3_000_00,
    ...overrides,
  };
}

describe("computeTrend", () => {
  it("roasChangePercent reflects a real ROAS improvement", () => {
    const current = totals({ spendMinorUnits: 100_00, purchaseValueMinorUnits: 500_00 }); // roas 5
    const previous = totals({ spendMinorUnits: 100_00, purchaseValueMinorUnits: 250_00 }); // roas 2.5
    const trend = computeTrend(current, previous);
    expect(trend.roasChangePercent).toBeCloseTo(100); // doubled
  });

  it("is null when the previous window has no spend/purchases to compare against", () => {
    const current = totals({ spendMinorUnits: 100_00, purchases: 5 });
    const previous = totals({ spendMinorUnits: 0, purchases: 0 });
    const trend = computeTrend(current, previous);
    expect(trend.roasChangePercent).toBeNull();
    expect(trend.cpaChangePercent).toBeNull();
  });

  it("purchaseVolumeTrend: UP beyond +10%, DOWN beyond -10%, STABLE within the band", () => {
    expect(
      computeTrend(totals({ purchases: 12 }), totals({ purchases: 10 })).purchaseVolumeTrend,
    ).toBe("UP");
    expect(
      computeTrend(totals({ purchases: 8 }), totals({ purchases: 10 })).purchaseVolumeTrend,
    ).toBe("DOWN");
    expect(
      computeTrend(totals({ purchases: 10 }), totals({ purchases: 10 })).purchaseVolumeTrend,
    ).toBe("STABLE");
  });

  it("purchaseVolumeTrend UP from zero previous purchases to any real purchases", () => {
    expect(
      computeTrend(totals({ purchases: 3 }), totals({ purchases: 0 })).purchaseVolumeTrend,
    ).toBe("UP");
  });

  it("purchaseVolumeTrend null when both windows had zero purchases", () => {
    expect(
      computeTrend(totals({ purchases: 0 }), totals({ purchases: 0 })).purchaseVolumeTrend,
    ).toBeNull();
  });

  it("spendVelocityChangePercent reflects a per-day spend rate change", () => {
    const current = totals({ spendMinorUnits: 1400_00 }); // 200/day over 7d
    const previous = totals({ spendMinorUnits: 700_00 }); // 100/day over 7d
    expect(computeTrend(current, previous).spendVelocityChangePercent).toBeCloseTo(100);
  });
});
