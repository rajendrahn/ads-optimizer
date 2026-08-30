import { describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  metaChangeEventKey,
  metaEntitySnapshotKey,
  metaInsightsDailyKey,
  recommendationOutcomeKey,
  shopifyOrderLineKey,
  shopifyRefundKey,
  syncStateKey,
} from "./collections.ts";

describe("COLLECTIONS", () => {
  it("lists every collection in §8 plus B3's metaInsightsReportJobs, and the name equals the key", () => {
    const names = [
      "metaCampaigns",
      "metaAdsets",
      "metaAds",
      "metaCreatives",
      "metaInsightsDaily",
      "metaEntitySnapshots",
      "metaChangeEvents",
      // Not one of §8's named collections — B3's own async-report-job bookkeeping, see
      // shared/schema/meta.ts's module comment on metaInsightsReportJobSchema.
      "metaInsightsReportJobs",
      "shopifyOrders",
      "shopifyOrderLines",
      "shopifyRefunds",
      "creativeAssets",
      "creativeFamilies",
      "adFeatures",
      "adsetFeatures",
      "accountFeatures",
      "decisionPackets",
      "recommendations",
      "recommendationOutcomes",
      "syncState",
      "syncRuns",
      "backtestRuns",
      "aiConversations",
      "accountMemory",
      "settings",
    ] as const;
    expect(Object.keys(COLLECTIONS).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(COLLECTIONS[name]).toBe(name);
    }
  });
});

describe("deterministic key helpers (§9.5)", () => {
  it("metaInsightsDailyKey — §9.5's given example", () => {
    expect(metaInsightsDailyKey("120210000000003", "2026-08-29")).toBe(
      "120210000000003_2026-08-29",
    );
  });

  it("metaInsightsDailyKey rejects an empty segment", () => {
    expect(() => metaInsightsDailyKey("", "2026-08-29")).toThrow();
    expect(() => metaInsightsDailyKey("120210000000003", "")).toThrow();
  });

  it("metaEntitySnapshotKey ties a snapshot to the run that produced it", () => {
    expect(metaEntitySnapshotKey("ADSET", "120210000000002", "sync_abc123")).toBe(
      "ADSET_120210000000002_sync_abc123",
    );
  });

  it("metaChangeEventKey is deterministic for the same diffed snapshot pair", () => {
    const key1 = metaChangeEventKey(
      "ADSET",
      "120210000000002",
      "BUDGET",
      "ADSET_120210000000002_sync_abc123",
    );
    const key2 = metaChangeEventKey(
      "ADSET",
      "120210000000002",
      "BUDGET",
      "ADSET_120210000000002_sync_abc123",
    );
    expect(key1).toBe(key2);
    expect(key1).toBe("ADSET_120210000000002_BUDGET_ADSET_120210000000002_sync_abc123");
  });

  it("shopifyOrderLineKey / shopifyRefundKey scope the child key to its parent order", () => {
    expect(shopifyOrderLineKey("5123456789012", "13123456789012")).toBe(
      "5123456789012_13123456789012",
    );
    expect(shopifyRefundKey("5123456789012", "999888777")).toBe("5123456789012_999888777");
  });

  it("recommendationOutcomeKey is 1:1 with the recommendation it evaluates", () => {
    expect(recommendationOutcomeKey("rec_123")).toBe("rec_123");
  });

  it("syncStateKey", () => {
    expect(syncStateKey("meta", "insights")).toBe("meta_insights");
    expect(syncStateKey("shopify", "orders")).toBe("shopify_orders");
  });

  it("rejects an ID segment containing a path separator", () => {
    expect(() => shopifyOrderLineKey("abc/def", "1")).toThrow();
  });
});
