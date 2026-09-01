import { describe, expect, it } from "vitest";
import { GcsRawArchiveStore } from "@services/ingest/sync/archiver.ts";
import { PointInTimeArchiveReader } from "./pointInTimeArchive.ts";
import { createFakeArchiveBucket, createFakeSyncRunSource } from "./testFixtures.ts";
import { reconstructMetaInsightsNormalizedAsOf } from "./reconstructMeta.ts";

const CTX = {
  accountId: "act_test",
  currency: "INR",
  attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
  reportingTimezone: "Asia/Kolkata",
  reportingCurrency: "INR",
  nativeTimezone: "Asia/Kolkata",
};

describe("reconstructMetaInsightsNormalizedAsOf", () => {
  it("parses archived insights_page payloads through B3's own normalizeInsightsRow + C1's own normalizeMetaInsightsDailyRow", async () => {
    const bucket = createFakeArchiveBucket();
    const archive = new GcsRawArchiveStore(bucket);
    await archive.archive({
      source: "meta",
      day: "2026-08-01",
      resource: "insights_page",
      runId: "run-a",
      payload: {
        data: [
          {
            ad_id: "ad_1",
            adset_id: "as_1",
            campaign_id: "cmp_1",
            date_start: "2026-08-01",
            spend: "1000.00",
            impressions: "500",
            clicks: "20",
            actions: [{ action_type: "omni_purchase", value: "3" }],
            action_values: [{ action_type: "omni_purchase", value: "5000.00" }],
          },
        ],
      },
    });
    const syncRuns = createFakeSyncRunSource([
      { runId: "run-a", status: "SUCCEEDED", finishedAt: new Date("2026-08-02T00:00:00Z") },
    ]);
    const reader = await PointInTimeArchiveReader.create({
      asOfInstant: new Date("2026-08-30T00:00:00Z"),
      archive,
      listable: bucket,
      syncRuns,
    });

    const rows = await reconstructMetaInsightsNormalizedAsOf(reader, CTX);
    expect(rows).toHaveLength(1);
    expect(rows[0].adId).toBe("ad_1");
    expect(rows[0].adsetId).toBe("as_1");
    expect(rows[0].reportingDay).toBe("2026-08-01");
    expect(rows[0].spend.amountMinorUnits).toBe(100000); // ₹1000.00 -> 100000 paise
    expect(rows[0].purchases).toBe(3);
    expect(rows[0].purchaseValue.amountMinorUnits).toBe(500000);
  });

  it("skips a malformed row rather than throwing for the whole payload", async () => {
    const bucket = createFakeArchiveBucket();
    const archive = new GcsRawArchiveStore(bucket);
    await archive.archive({
      source: "meta",
      day: "2026-08-01",
      resource: "insights_page",
      runId: "run-b",
      payload: {
        data: [
          { ad_id: "", adset_id: "as_1", campaign_id: "cmp_1", date_start: "2026-08-01" }, // missing ad_id
          {
            ad_id: "ad_2",
            adset_id: "as_1",
            campaign_id: "cmp_1",
            date_start: "2026-08-01",
            spend: "10.00",
          },
        ],
      },
    });
    const syncRuns = createFakeSyncRunSource([
      { runId: "run-b", status: "SUCCEEDED", finishedAt: new Date("2026-08-02T00:00:00Z") },
    ]);
    const reader = await PointInTimeArchiveReader.create({
      asOfInstant: new Date("2026-08-30T00:00:00Z"),
      archive,
      listable: bucket,
      syncRuns,
    });
    const rows = await reconstructMetaInsightsNormalizedAsOf(reader, CTX);
    expect(rows).toHaveLength(1);
    expect(rows[0].adId).toBe("ad_2");
  });

  it("respects the point-in-time boundary end to end (no rows from a not-yet-completed run)", async () => {
    const bucket = createFakeArchiveBucket();
    const archive = new GcsRawArchiveStore(bucket);
    await archive.archive({
      source: "meta",
      day: "2026-08-01",
      resource: "insights_page",
      runId: "run-future",
      payload: {
        data: [{ ad_id: "ad_9", adset_id: "as_9", campaign_id: "cmp_9", date_start: "2026-08-01" }],
      },
    });
    const syncRuns = createFakeSyncRunSource([
      { runId: "run-future", status: "SUCCEEDED", finishedAt: new Date("2026-09-15T00:00:00Z") },
    ]);
    const reader = await PointInTimeArchiveReader.create({
      asOfInstant: new Date("2026-08-30T00:00:00Z"),
      archive,
      listable: bucket,
      syncRuns,
    });
    const rows = await reconstructMetaInsightsNormalizedAsOf(reader, CTX);
    expect(rows).toHaveLength(0);
  });
});
