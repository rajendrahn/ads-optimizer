// Round-trip validity for every collection schema in §8: one minimal-but-realistic fixture
// per collection parses cleanly, plus a handful of negative cases for the shared primitives
// every schema in this directory is built from. Pure — no Firestore, no emulator.

import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import {
  accountMemorySchema,
  aiConversationSchema,
  attributionProvenance,
  backtestRunSchema,
  creativeAssetSchema,
  creativeFamilySchema,
  decisionPacketSchema,
  entityFeaturesSchema,
  firestoreTimestamp,
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaChangeEventSchema,
  metaCreativeSchema,
  metaEntitySnapshotSchema,
  metaInsightsDailySchema,
  moneyMinorUnits,
  recommendationOutcomeSchema,
  recommendationSchema,
  reportingCanonSettingsSchema,
  reportingDay,
  shopifyOrderLineSchema,
  shopifyOrderSchema,
  shopifyRefundSchema,
  syncRunSchema,
  syncStateSchema,
} from "./index.ts";

const NOW = new Date("2026-08-30T12:00:00Z");

describe("shared primitives", () => {
  it("firestoreTimestamp normalizes a Firestore Timestamp, a Date and an ISO string alike", () => {
    const fromTimestamp = firestoreTimestamp.parse(Timestamp.fromDate(NOW));
    const fromDate = firestoreTimestamp.parse(NOW);
    const fromString = firestoreTimestamp.parse(NOW.toISOString());
    expect(fromTimestamp).toBeInstanceOf(Date);
    expect(fromTimestamp.getTime()).toBe(NOW.getTime());
    expect(fromDate.getTime()).toBe(NOW.getTime());
    expect(fromString.getTime()).toBe(NOW.getTime());
  });

  it("rejects a non-date value", () => {
    expect(() => firestoreTimestamp.parse("not a date")).toThrow();
    expect(firestoreTimestamp.safeParse("not a date").success).toBe(false);
  });

  it("money must be an integer minor-units amount — a float is rejected (§0.2)", () => {
    expect(moneyMinorUnits.safeParse({ amountMinorUnits: 1050, currency: "INR" }).success).toBe(
      true,
    );
    expect(moneyMinorUnits.safeParse({ amountMinorUnits: 10.5, currency: "INR" }).success).toBe(
      false,
    );
    expect(moneyMinorUnits.safeParse({ amountMinorUnits: 1050, currency: "INRR" }).success).toBe(
      false,
    );
  });

  it("reportingDay only accepts YYYY-MM-DD", () => {
    expect(reportingDay.safeParse("2026-08-30").success).toBe(true);
    expect(reportingDay.safeParse("2026-08-30T00:00:00Z").success).toBe(false);
    expect(reportingDay.safeParse("30-08-2026").success).toBe(false);
  });

  it("attributionProvenance requires both fields non-empty (§5.3)", () => {
    expect(
      attributionProvenance.safeParse({
        attributionWindow: "7d_click_1d_view",
        purchaseActionType: "offsite_conversion.fb_pixel_purchase",
      }).success,
    ).toBe(true);
    expect(
      attributionProvenance.safeParse({ attributionWindow: "", purchaseActionType: "x" }).success,
    ).toBe(false);
  });
});

describe("meta collection schemas", () => {
  it("metaCampaigns", () => {
    expect(() =>
      metaCampaignSchema.parse({
        campaignId: "120210000000001",
        accountId: "act_456833154967349",
        name: "Diwali Sale",
        status: "ACTIVE",
        objective: "OUTCOME_SALES",
        buyingType: "AUCTION",
        budget: {
          ownerLevel: "CAMPAIGN",
          dailyBudgetMinorUnits: 500000,
          lifetimeBudgetMinorUnits: null,
          currency: "INR",
        },
        bidStrategy: "LOWEST_COST_WITHOUT_CAP",
        createdAt: NOW,
        metaUpdatedAt: NOW,
        syncedAt: NOW,
      }),
    ).not.toThrow();
  });

  it("metaAdsets, with ambiguous budget ownership stored explicitly (§4.1)", () => {
    expect(() =>
      metaAdsetSchema.parse({
        adsetId: "120210000000002",
        campaignId: "120210000000001",
        accountId: "act_456833154967349",
        name: "Bridal — Broad",
        status: "ACTIVE",
        budget: {
          ownerLevel: "UNKNOWN",
          dailyBudgetMinorUnits: null,
          lifetimeBudgetMinorUnits: null,
          currency: "INR",
        },
        optimizationGoal: "OFFSITE_CONVERSIONS",
        bidStrategy: null,
        targeting: { age_min: 21 },
        placements: ["facebook_feed"],
        attribution: null,
        createdAt: NOW,
        metaUpdatedAt: NOW,
        syncedAt: NOW,
      }),
    ).not.toThrow();
  });

  it("metaAds", () => {
    expect(() =>
      metaAdSchema.parse({
        adId: "120210000000003",
        adsetId: "120210000000002",
        campaignId: "120210000000001",
        accountId: "act_456833154967349",
        creativeId: "120210000000004",
        name: "Model wearing temple set",
        status: "ACTIVE",
        destinationUrl: "https://shopsparkleandglow.com/products/x?utm_content={{ad.id}}",
        createdAt: NOW,
        metaUpdatedAt: NOW,
        syncedAt: NOW,
      }),
    ).not.toThrow();
  });

  it("metaCreatives, including a COMPOSITE creative (§7.3)", () => {
    expect(() =>
      metaCreativeSchema.parse({
        creativeId: "120210000000004",
        accountId: "act_456833154967349",
        name: null,
        imageHash: null,
        videoId: null,
        creativeType: "COMPOSITE",
        memberAssetHashes: ["a1b2", "c3d4"],
        deliveredMixObservable: false,
        bodyText: null,
        headline: null,
        linkUrl: null,
        syncedAt: NOW,
      }),
    ).not.toThrow();
  });

  it("metaInsightsDaily carries attribution provenance on every row (§5.3)", () => {
    expect(() =>
      metaInsightsDailySchema.parse({
        adId: "120210000000003",
        adsetId: "120210000000002",
        campaignId: "120210000000001",
        accountId: "act_456833154967349",
        date: "2026-08-29",
        attribution: {
          attributionWindow: "7d_click_1d_view",
          purchaseActionType: "offsite_conversion.fb_pixel_purchase",
        },
        spendMinorUnits: 123400,
        currency: "INR",
        impressions: 10000,
        reach: 8000,
        frequency: 1.25,
        clicks: 200,
        landingPageViews: 150,
        addToCart: 20,
        initiateCheckout: 10,
        purchases: 5,
        purchaseValueMinorUnits: 500000,
        sourceUpdatedAt: NOW,
        fetchedAt: NOW,
      }),
    ).not.toThrow();
  });

  it("metaEntitySnapshots", () => {
    expect(() =>
      metaEntitySnapshotSchema.parse({
        entityType: "ADSET",
        entityId: "120210000000002",
        syncRunId: "sync_abc123",
        takenAt: NOW,
        budget: null,
        status: "ACTIVE",
        targeting: null,
        bidStrategy: null,
        creativeAssignment: ["120210000000004"],
      }),
    ).not.toThrow();
  });

  it("metaChangeEvents, a budget change with before/after/percent (B4)", () => {
    expect(() =>
      metaChangeEventSchema.parse({
        entityType: "ADSET",
        entityId: "120210000000002",
        field: "BUDGET",
        detectedAt: NOW,
        fromSnapshotKey: "ADSET_120210000000002_sync_abc122",
        toSnapshotKey: "ADSET_120210000000002_sync_abc123",
        before: 40000,
        after: 46000,
        budgetChangePercent: 15,
        actor: null,
      }),
    ).not.toThrow();
  });
});

describe("shopify collection schemas", () => {
  it("shopifyOrders — no PII fields present (§17.2)", () => {
    const parsed = shopifyOrderSchema.parse({
      orderId: "5123456789012",
      orderNumber: "#1042",
      createdAt: NOW,
      sourceUpdatedAt: NOW,
      currency: "INR",
      totalPriceMinorUnits: 299900,
      subtotalPriceMinorUnits: 279900,
      totalDiscountsMinorUnits: 0,
      financialStatus: "paid",
      fulfillmentStatus: null,
      cancelledAt: null,
      customerId: "gid://shopify/Customer/1",
      isNewCustomer: true,
      country: "IN",
      landingSite: "/products/x?utm_source=meta&utm_content=120210000000003",
      referringSite: null,
      rawAttributionTag: "utm_content=120210000000003",
      resolvedAdId: null,
      resolvedCampaignId: null,
      source: "GRAPHQL_SYNC",
      syncedAt: NOW,
    });
    expect(Object.keys(parsed)).not.toContain("email");
    expect(Object.keys(parsed)).not.toContain("name");
    expect(Object.keys(parsed)).not.toContain("phone");
  });

  it("shopifyOrderLines", () => {
    expect(() =>
      shopifyOrderLineSchema.parse({
        orderId: "5123456789012",
        lineItemId: "13123456789012",
        productId: "8123456789012",
        variantId: "44123456789012",
        sku: "TBS-001",
        title: "Temple Bridal Set",
        quantity: 1,
        priceMinorUnits: 279900,
        currency: "INR",
        productTags: ["bridal", "temple"],
        sourceUpdatedAt: NOW,
        syncedAt: NOW,
      }),
    ).not.toThrow();
  });

  it("shopifyRefunds", () => {
    expect(() =>
      shopifyRefundSchema.parse({
        orderId: "5123456789012",
        refundId: "999888777",
        createdAt: NOW,
        amountMinorUnits: 50000,
        currency: "INR",
        reason: "customer request",
        sourceUpdatedAt: NOW,
        syncedAt: NOW,
      }),
    ).not.toThrow();
  });
});

describe("creative collection schemas", () => {
  it("creativeAssets", () => {
    expect(() =>
      creativeAssetSchema.parse({
        assetHash: "a1b2c3d4",
        sourceType: "IMAGE",
        metaImageHash: "a1b2c3d4",
        metaVideoId: null,
        perceptualHash: null,
        cloudStoragePath: null,
        thumbnailUrl: null,
        copy: null,
        ocrText: null,
        transcript: null,
        structuredTags: null,
        embedding: null,
        familyId: null,
        analysisTimestamp: null,
        analysisModelVersion: null,
        discoveredAt: NOW,
      }),
    ).not.toThrow();
  });

  it("creativeFamilies, a composite excluded from fatigue scoring (§7.3)", () => {
    expect(() =>
      creativeFamilySchema.parse({
        familyId: "fam_a1b2c3d4",
        memberAssetHashes: ["a1b2c3d4"],
        creativeType: "COMPOSITE",
        eligibleForFamilyFatigueScore: false,
        familyAgeDays: null,
        totalHistoricalSpendMinorUnits: null,
        activeAdsCount: null,
        variationCount: null,
        fatigueScore: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).not.toThrow();
  });
});

describe("feature collection schema (shared across adFeatures/adsetFeatures/accountFeatures)", () => {
  it("parses a fully-populated entity, including a NOT_DISTINGUISHABLE verdict (§15.2)", () => {
    expect(() =>
      entityFeaturesSchema.parse({
        entityId: "120210000000002",
        entityType: "ADSET",
        accountDataVersion: 42,
        computedAt: NOW,
        windows: {
          "28d": {
            purchases: {
              value: 6,
              intervalLow: 2,
              intervalHigh: 11,
              sampleSize: 6,
              verdict: "NOT_DISTINGUISHABLE",
            },
            metaRoas: {
              value: 3.9,
              intervalLow: 3.1,
              intervalHigh: 4.8,
              sampleSize: 6,
              verdict: null,
            },
            metaRoasShrunk: 3.74,
          },
        },
        trend: { purchaseVolumeTrend: "STABLE" },
        changeAware: { hoursSinceLastBudgetChange: 72 },
        learningPhase: { inLearningPhase: true },
      }),
    ).not.toThrow();
  });

  it("parses a minimal entity — every metric is optional (C2/C3/C4 not run yet)", () => {
    expect(() =>
      entityFeaturesSchema.parse({
        entityId: "act_456833154967349",
        entityType: "ACCOUNT",
        accountDataVersion: 1,
        computedAt: NOW,
        windows: {},
        trend: {},
        changeAware: {},
        learningPhase: {},
      }),
    ).not.toThrow();
  });

  it("rejects an unknown window label", () => {
    expect(
      entityFeaturesSchema.safeParse({
        entityId: "x",
        entityType: "AD",
        accountDataVersion: 1,
        computedAt: NOW,
        windows: { "3d": {} },
        trend: {},
        changeAware: {},
        learningPhase: {},
      }).success,
    ).toBe(false);
  });
});

describe("decision collection schemas", () => {
  it("decisionPackets", () => {
    expect(() =>
      decisionPacketSchema.parse({
        packetId: "pkt_1",
        decisionUnit: { type: "ADSET", id: "120210000000002" },
        escalatedFrom: { type: "AD", id: "120210000000003", reason: "SAMPLE_TOO_SMALL" },
        accountDataVersion: 42,
        isStale: false,
        evidence: { roas28d: 3.91 },
        textRendering:
          "28-day ROAS 3.91 (interval 3.10-4.82) against a 3.0 target, on 128 purchases",
        createdAt: NOW,
      }),
    ).not.toThrow();
  });

  it("recommendations — the §20.1 example shape", () => {
    expect(() =>
      recommendationSchema.parse({
        recommendationId: "rec_123",
        status: "COMPLETE",
        packetId: "pkt_1",
        decisionUnit: { type: "ADSET", id: "AS_17" },
        recommendation: "INCREASE_BUDGET",
        currentBudgetMinorUnits: 1000000,
        recommendedBudgetMinorUnits: 1150000,
        changePercent: 15,
        confidence: 0.72,
        summary: "Increase the budget by 15%.",
        primaryReasons: [
          "28-day ROAS 3.91 (interval 3.10-4.82) against a 3.0 target, on 128 purchases",
        ],
        risks: ["Attribution coverage is 0.68"],
        doNotDo: ["Do not increase by 30% or more in one step"],
        recheckConditions: {
          minimumAdditionalSpendMinorUnits: 1500000,
          minimumAdditionalPurchases: 15,
        },
        guardrailRejection: null,
        accountDataVersionAtGeneration: 42,
        requestedBy: "rajendrahn38@gmail.com",
        requestedQuestion: "Should I increase the budget of Ad XYZ?",
        errorMessage: null,
        createdAt: NOW,
        updatedAt: NOW,
        acceptedAt: null,
        rejectedByUserAt: null,
      }),
    ).not.toThrow();
  });

  it("recommendations — PENDING immediately after the API writes it (§16.1)", () => {
    expect(() =>
      recommendationSchema.parse({
        recommendationId: "rec_124",
        status: "PENDING",
        packetId: null,
        decisionUnit: null,
        recommendation: null,
        currentBudgetMinorUnits: null,
        recommendedBudgetMinorUnits: null,
        changePercent: null,
        confidence: null,
        summary: null,
        primaryReasons: null,
        risks: null,
        doNotDo: null,
        recheckConditions: null,
        guardrailRejection: null,
        accountDataVersionAtGeneration: null,
        requestedBy: "rajendrahn38@gmail.com",
        requestedQuestion: "Should I increase the budget of Ad XYZ?",
        errorMessage: null,
        createdAt: NOW,
        updatedAt: NOW,
        acceptedAt: null,
        rejectedByUserAt: null,
      }),
    ).not.toThrow();
  });

  it("recommendationOutcomes — compares against the shrunk baseline (§21.1)", () => {
    expect(() =>
      recommendationOutcomeSchema.parse({
        recommendationId: "rec_123",
        evaluatedAt: NOW,
        triggeredBy: "RECHECK_CONDITIONS_MET",
        additionalSpendMinorUnits: 1584000,
        additionalPurchases: 17,
        roasAfter: 3.82,
        baselineShrunk: 3.74,
        classification: "NEUTRAL",
        createdAt: NOW,
      }),
    ).not.toThrow();
  });
});

describe("sync collection schemas", () => {
  it("syncState — the §9.3 example shape", () => {
    expect(() =>
      syncStateSchema.parse({
        source: "meta",
        resource: "insights",
        accountId: "act_456833154967349",
        lastSuccessfulSyncAt: NOW,
        lastDataDate: "2026-08-28",
        reconciliationDays: 14,
        attributionWindow: "7d_click_1d_view",
        status: "healthy",
        lastRunId: "sync_abc123",
      }),
    ).not.toThrow();
  });

  it("syncRuns, with a logged version-guard rejection (§9.5)", () => {
    expect(() =>
      syncRunSchema.parse({
        runId: "sync_abc123",
        taskType: "SHOPIFY_RECONCILE_ORDERS",
        source: "shopify",
        status: "SUCCEEDED",
        startedAt: NOW,
        finishedAt: NOW,
        error: null,
        watermarkBefore: "2026-08-28T00:00:00Z",
        watermarkAfter: "2026-08-29T00:00:00Z",
        versionGuardRejections: [
          {
            collection: "shopifyOrders",
            docId: "5123456789012",
            reason:
              "incoming sourceUpdatedAt 2026-08-27T00:00:00.000Z is older than stored 2026-08-28T00:00:00.000Z",
            incomingUpdatedAt: NOW,
            currentUpdatedAt: NOW,
            loggedAt: NOW,
          },
        ],
      }),
    ).not.toThrow();
  });

  it("backtestRuns — must be comparable against the naive baseline (§21.2/§29)", () => {
    expect(() =>
      backtestRunSchema.parse({
        backtestRunId: "bt_1",
        asOfDate: "2026-01-15",
        strategy: "NAIVE_HIGHEST_RECENT_ROAS",
        decisionUnit: { type: "ADSET", id: "AS_17" },
        generatedRecommendation: null,
        actualOutcome: null,
        brierScoreComponent: 0.04,
        createdAt: NOW,
      }),
    ).not.toThrow();
  });
});

describe("ai collection schemas", () => {
  it("aiConversations", () => {
    expect(() =>
      aiConversationSchema.parse({
        conversationId: "conv_1",
        userId: "rajendrahn38@gmail.com",
        messages: [
          { role: "user", content: "Should I increase the budget of Ad XYZ?", createdAt: NOW },
        ],
        relatedRecommendationIds: ["rec_123"],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).not.toThrow();
  });

  it("accountMemory", () => {
    expect(() =>
      accountMemorySchema.parse({
        memoryId: "mem_1",
        scope: "ACCOUNT",
        entityId: null,
        pattern: "13 of 17 historical scale events were followed by stable or improved ROAS.",
        supportingStats: { n: 17, successes: 13 },
        confidence: 0.6,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).not.toThrow();
  });
});

describe("settings schema", () => {
  it("reportingCanonSettings — the §5 example, verbatim", () => {
    expect(() =>
      reportingCanonSettingsSchema.parse({
        accountId: "act_456833154967349",
        reportingTimezone: "Asia/Kolkata",
        reportingCurrency: "INR",
        attributionWindow: "7d_click_1d_view",
        purchaseActionType: "offsite_conversion.fb_pixel_purchase",
      }),
    ).not.toThrow();
  });
});
