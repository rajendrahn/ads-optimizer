import { describe, expect, it } from "vitest";
import { tallyResolvedOrders } from "@services/ingest/shopify/attribution/index.ts";
import { markGap } from "./gapAware.ts";
import type { MetaWindowTotals } from "./metaWindowAggregate.ts";
import type { ShopifyWindowTotals } from "./shopifyWindowAggregate.ts";
import { NULL_SEASONALITY_CONTEXT } from "./seasonality.ts";
import { buildWindowMetrics } from "./windowMetricsBuilder.ts";

const META: MetaWindowTotals = {
  currency: "INR",
  attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
  spendMinorUnits: 1_000_00,
  impressions: 10000,
  reach: 8000,
  clicks: 500,
  landingPageViews: 400,
  addToCart: 40,
  initiateCheckout: 20,
  purchases: 10,
  purchaseValueMinorUnits: 4_000_00,
};

const SHOPIFY: ShopifyWindowTotals = {
  currency: "INR",
  ordersCount: 5,
  newCustomerOrdersCount: 2,
  grossRevenueMinorUnits: 2_500_00,
  refundsAmountMinorUnits: 100_00,
  netRevenueMinorUnits: 2_400_00,
};

const NO_GAP = markGap(SHOPIFY, false, []);
const TALLY = tallyResolvedOrders([
  { resolutionMethod: "AD_ID" },
  { resolutionMethod: "AD_ID" },
  { resolutionMethod: "NAME_MATCH" },
]);

describe("buildWindowMetrics", () => {
  it("computes delivery/traffic/funnel ratios from Meta totals", () => {
    const wm = buildWindowMetrics({
      meta: META,
      shopifyAttributedIdOnly: NO_GAP,
      coverageTally: TALLY,
      accountUnconditionalTotals: null,
      shopifyMetricsExcludedAsUnresolvable: false,
      seasonality: NULL_SEASONALITY_CONTEXT,
    });
    expect(wm.spendMinorUnits).toBe(1_000_00);
    expect(wm.frequency).toBeCloseTo(10000 / 8000);
    expect(wm.cpmMinorUnits).toBeCloseTo((1_000_00 * 1000) / 10000);
    expect(wm.ctr).toBeCloseTo(500 / 10000);
    expect(wm.cvr).toBeCloseTo(10 / 500);
    expect(wm.addToCartRate).toBeCloseTo(40 / 400);
    expect(wm.checkoutStartedRate).toBeCloseTo(20 / 40);
    expect(wm.purchaseRate).toBeCloseTo(10 / 20);
    expect(wm.metaRoas?.value).toBeCloseTo(4_000_00 / 1_000_00);
    expect(wm.cpa?.value).toBeCloseTo(1_000_00 / 10);
  });

  it("leaves metaRoasShrunk/shopifyRoasShrunk/interval/verdict null — C3's job, never C2's", () => {
    const wm = buildWindowMetrics({
      meta: META,
      shopifyAttributedIdOnly: NO_GAP,
      coverageTally: TALLY,
      accountUnconditionalTotals: null,
      shopifyMetricsExcludedAsUnresolvable: false,
      seasonality: NULL_SEASONALITY_CONTEXT,
    });
    expect(wm.metaRoasShrunk).toBeNull();
    expect(wm.shopifyRoasShrunk).toBeNull();
    expect(wm.metaRoas?.intervalLow).toBeNull();
    expect(wm.metaRoas?.verdict).toBeNull();
  });

  it("computes attributed Shopify figures and the coverage ratio", () => {
    const wm = buildWindowMetrics({
      meta: META,
      shopifyAttributedIdOnly: NO_GAP,
      coverageTally: TALLY,
      accountUnconditionalTotals: null,
      shopifyMetricsExcludedAsUnresolvable: false,
      seasonality: NULL_SEASONALITY_CONTEXT,
    });
    expect(wm.shopifyAttributedPurchases).toBe(5);
    expect(wm.shopifyAttributedRevenueMinorUnits).toBe(2_500_00);
    expect(wm.shopifyNetRevenueMinorUnits).toBe(2_400_00);
    expect(wm.aov).toBeCloseTo(2_500_00 / 5);
    expect(wm.newCustomerPercent).toBeCloseTo(2 / 5);
    expect(wm.refundRate).toBeCloseTo(100_00 / 2_500_00);
    // coverageRatio is ID-only (2/10), never pooled with the NAME_MATCH order.
    expect(wm.attributionCoverageRatio).toBeCloseTo(2 / 10);
    expect(wm.attributionCoverageRatioIncludingNameMatch).toBeCloseTo(3 / 10);
  });

  it("§6.3: an ad the URL-tag audit found unresolvable gets null Shopify-attributed figures, never zero", () => {
    const wm = buildWindowMetrics({
      meta: META,
      shopifyAttributedIdOnly: NO_GAP,
      coverageTally: TALLY,
      accountUnconditionalTotals: null,
      shopifyMetricsExcludedAsUnresolvable: true,
      seasonality: NULL_SEASONALITY_CONTEXT,
    });
    expect(wm.shopifyAttributedPurchases).toBeNull();
    expect(wm.shopifyAttributedRevenueMinorUnits).toBeNull();
    expect(wm.shopifyNetRevenueMinorUnits).toBeNull();
    expect(wm.shopifyRoas?.value).toBeNull();
    expect(wm.aov).toBeNull();
    expect(wm.refundRate).toBeNull();
    // Meta figures for the SAME ad are entirely unaffected.
    expect(wm.spendMinorUnits).toBe(1_000_00);
    expect(wm.metaRoas?.value).not.toBeNull();
  });

  it("carries the gap verdict through onto shopifyDataGap, unmodified", () => {
    const gapAware = markGap(SHOPIFY, true, ["2025-12-20"]);
    const wm = buildWindowMetrics({
      meta: META,
      shopifyAttributedIdOnly: gapAware,
      coverageTally: TALLY,
      accountUnconditionalTotals: null,
      shopifyMetricsExcludedAsUnresolvable: false,
      seasonality: NULL_SEASONALITY_CONTEXT,
    });
    expect(wm.shopifyDataGap).toEqual({ windowHasDataGap: true, gapDays: ["2025-12-20"] });
    // Still not suppressed — the number is there, flagged.
    expect(wm.shopifyAttributedRevenueMinorUnits).toBe(2_500_00);
  });

  it("blendedMerAccountOnly is null unless accountUnconditionalTotals is supplied", () => {
    const withAccount = buildWindowMetrics({
      meta: META,
      shopifyAttributedIdOnly: NO_GAP,
      coverageTally: TALLY,
      accountUnconditionalTotals: markGap(
        { ...SHOPIFY, netRevenueMinorUnits: 5_000_00 },
        false,
        [],
      ),
      shopifyMetricsExcludedAsUnresolvable: false,
      seasonality: NULL_SEASONALITY_CONTEXT,
    });
    expect(withAccount.blendedMerAccountOnly).toBeCloseTo(5_000_00 / 1_000_00);

    const withoutAccount = buildWindowMetrics({
      meta: META,
      shopifyAttributedIdOnly: NO_GAP,
      coverageTally: TALLY,
      accountUnconditionalTotals: null,
      shopifyMetricsExcludedAsUnresolvable: false,
      seasonality: NULL_SEASONALITY_CONTEXT,
    });
    expect(withoutAccount.blendedMerAccountOnly).toBeNull();
  });

  it("blendedMer is null (undefined, not zero/infinite) when there was no spend", () => {
    const zeroSpendMeta: MetaWindowTotals = { ...META, spendMinorUnits: 0 };
    const wm = buildWindowMetrics({
      meta: zeroSpendMeta,
      shopifyAttributedIdOnly: NO_GAP,
      coverageTally: TALLY,
      accountUnconditionalTotals: markGap(SHOPIFY, false, []),
      shopifyMetricsExcludedAsUnresolvable: false,
      seasonality: NULL_SEASONALITY_CONTEXT,
    });
    expect(wm.blendedMerAccountOnly).toBeNull();
    expect(wm.metaRoas?.value).toBeNull();
    expect(wm.cpa?.value).toBeCloseTo(0); // spend 0 / purchases 10 = 0, a real number, not undefined
  });

  it("attaches the seasonality context verbatim, never adjusting a metric based on it", () => {
    const context = {
      labels: ["diwali"],
      spansSeasonalBoundary: true,
      demandIndex: 2.4,
      demandIndexSampleSize: 1,
      summaryText: "This window covers Diwali.",
    };
    const wm = buildWindowMetrics({
      meta: META,
      shopifyAttributedIdOnly: NO_GAP,
      coverageTally: TALLY,
      accountUnconditionalTotals: null,
      shopifyMetricsExcludedAsUnresolvable: false,
      seasonality: context,
    });
    expect(wm.seasonality).toEqual(context);
    // The metric itself is identical to the non-seasonal case above.
    expect(wm.metaRoas?.value).toBeCloseTo(4_000_00 / 1_000_00);
  });
});
