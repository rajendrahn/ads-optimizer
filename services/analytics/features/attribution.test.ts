import { describe, expect, it } from "vitest";
import type {
  NormalizedMoney,
  ReportingDay,
  ShopifyOrderNormalized,
  ShopifyRefundNormalized,
} from "@shared/schema/index.ts";
import {
  buildOrderAttributionIndex,
  ordersAttributedToEntity,
  refundsAttributedToEntity,
} from "./attribution.ts";
import { buildEntityGraph, type EntityGraph } from "./entityGraph.ts";

function money(amountMinorUnits: number): NormalizedMoney {
  return {
    amountMinorUnits,
    currency: "INR",
    sourceAmountMinorUnits: amountMinorUnits,
    sourceCurrency: "INR",
    fxRateToReportingCurrency: 1,
    fxRateSource: "same_currency_no_conversion",
  };
}

function order(
  overrides: Partial<ShopifyOrderNormalized> & { orderId: string },
): ShopifyOrderNormalized {
  return {
    reportingDay: "2026-08-25" as ReportingDay,
    reportingTimezone: "Asia/Kolkata",
    nativeCreatedAt: new Date("2026-08-25T00:00:00Z"),
    totalPrice: money(500000),
    subtotalPrice: money(500000),
    totalDiscounts: money(0),
    totalShipping: null,
    isNewCustomer: false,
    country: "IN",
    customerId: "cust_1",
    resolvedAdId: null,
    resolvedCampaignId: null,
    resolutionMethod: "UNRESOLVED",
    resolutionConfidence: null,
    source: "GRAPHQL_SYNC",
    sourceUpdatedAt: new Date("2026-08-25T00:00:00Z"),
    computedAt: new Date("2026-08-31T00:00:00Z"),
    ...overrides,
  };
}

// Minimal graph: ad a1 -> adset as1 -> campaign c1 -> family f1; ad a2 -> adset as2 -> campaign c1
const graph: EntityGraph = buildEntityGraph({
  ads: [
    {
      adId: "a1",
      adsetId: "as1",
      campaignId: "c1",
      accountId: "act_1",
      creativeId: null,
      name: "a1",
      status: "ACTIVE",
      destinationUrl: null,
      createdAt: new Date(),
      metaUpdatedAt: new Date(),
      syncedAt: new Date(),
    },
    {
      adId: "a2",
      adsetId: "as2",
      campaignId: "c1",
      accountId: "act_1",
      creativeId: null,
      name: "a2",
      status: "ACTIVE",
      destinationUrl: null,
      createdAt: new Date(),
      metaUpdatedAt: new Date(),
      syncedAt: new Date(),
    },
  ],
  adsets: [],
  campaigns: [],
  creatives: [],
  assets: [],
  families: [],
});

describe("ordersAttributedToEntity", () => {
  it("AD level: matches only AD_ID orders for this exact ad id by default", () => {
    const orders = [
      order({ orderId: "o1", resolvedAdId: "a1", resolutionMethod: "AD_ID" }),
      order({ orderId: "o2", resolvedAdId: "a2", resolutionMethod: "AD_ID" }),
      order({ orderId: "o3", resolvedAdId: "a1", resolutionMethod: "NAME_MATCH" }),
    ];
    const matched = ordersAttributedToEntity(orders, "AD", "a1", graph);
    expect(matched.map((o) => o.orderId)).toEqual(["o1"]);
  });

  it("AD level with includeNameMatch:true also includes NAME_MATCH for the same ad", () => {
    const orders = [
      order({ orderId: "o1", resolvedAdId: "a1", resolutionMethod: "AD_ID" }),
      order({ orderId: "o3", resolvedAdId: "a1", resolutionMethod: "NAME_MATCH" }),
    ];
    const matched = ordersAttributedToEntity(orders, "AD", "a1", graph, true);
    expect(matched.map((o) => o.orderId).sort()).toEqual(["o1", "o3"]);
  });

  it("ADSET level rolls up member ads via the graph", () => {
    const orders = [
      order({ orderId: "o1", resolvedAdId: "a1", resolutionMethod: "AD_ID" }),
      order({ orderId: "o2", resolvedAdId: "a2", resolutionMethod: "AD_ID" }),
    ];
    expect(ordersAttributedToEntity(orders, "ADSET", "as1", graph).map((o) => o.orderId)).toEqual([
      "o1",
    ]);
  });

  it("CAMPAIGN level matches both a direct campaign-granularity resolution and a rolled-up ad", () => {
    const orders = [
      order({ orderId: "o1", resolvedAdId: "a1", resolutionMethod: "AD_ID" }),
      order({ orderId: "o2", resolvedCampaignId: "c1", resolutionMethod: "AD_ID" }), // campaign-only
    ];
    expect(
      ordersAttributedToEntity(orders, "CAMPAIGN", "c1", graph)
        .map((o) => o.orderId)
        .sort(),
    ).toEqual(["o1", "o2"]);
  });

  it("ACCOUNT level matches any resolved order regardless of which entity it names", () => {
    const orders = [
      order({ orderId: "o1", resolvedAdId: "a1", resolutionMethod: "AD_ID" }),
      order({ orderId: "o2", resolutionMethod: "UNRESOLVED" }),
    ];
    expect(
      ordersAttributedToEntity(orders, "ACCOUNT", "act_1", graph).map((o) => o.orderId),
    ).toEqual(["o1"]);
  });

  it("never matches an UNRESOLVED order at any level", () => {
    const orders = [order({ orderId: "o1", resolutionMethod: "UNRESOLVED" })];
    expect(ordersAttributedToEntity(orders, "ACCOUNT", "act_1", graph, true)).toEqual([]);
  });
});

describe("refundsAttributedToEntity", () => {
  function refund(
    overrides: Partial<ShopifyRefundNormalized> & { orderId: string; refundId: string },
  ): ShopifyRefundNormalized {
    return {
      reportingDay: "2026-08-27" as ReportingDay,
      reportingTimezone: "Asia/Kolkata",
      nativeCreatedAt: new Date("2026-08-27T00:00:00Z"),
      amount: money(10000),
      reason: null,
      sourceUpdatedAt: new Date("2026-08-27T00:00:00Z"),
      computedAt: new Date("2026-08-31T00:00:00Z"),
      ...overrides,
    };
  }

  it("resolves a refund's entity via its PARENT order's attribution, not its own fields", () => {
    const parentOrders = [order({ orderId: "o1", resolvedAdId: "a1", resolutionMethod: "AD_ID" })];
    const index = buildOrderAttributionIndex(parentOrders);
    const refunds = [refund({ orderId: "o1", refundId: "r1" })];
    expect(
      refundsAttributedToEntity(refunds, index, "AD", "a1", graph).map((r) => r.refundId),
    ).toEqual(["r1"]);
  });

  it("excludes a refund whose parent order is unknown (predates the fetch window) rather than guessing", () => {
    const index = buildOrderAttributionIndex([]); // parent order never seen
    const refunds = [refund({ orderId: "o_unknown", refundId: "r1" })];
    expect(refundsAttributedToEntity(refunds, index, "AD", "a1", graph)).toEqual([]);
  });
});
