import { describe, expect, it } from "vitest";
import { GcsRawArchiveStore } from "@services/ingest/sync/archiver.ts";
import { PointInTimeArchiveReader } from "./pointInTimeArchive.ts";
import { createFakeArchiveBucket, createFakeSyncRunSource } from "./testFixtures.ts";
import { reconstructShopifyNormalizedAsOf } from "./reconstructShopify.ts";

// Synthetic Matrixify-shaped CSV — matches the header set services/ingest/shopify/orders/
// csvNormalize.ts reads. Customer IDs and every identifier below are made up for this test only
// — never a real value (per this step's safety constraints).
const CSV_HEADER =
  "ID,Name,Created At,Updated At,Currency,Price: Total,Price: Subtotal,Price: Total Discount," +
  "Price: Total Shipping,Shipping: Country Code,Billing: Country Code,Payment: Status," +
  "Customer: ID,Browser: Landing Page,Browser: Referrer,Cancelled At,Line: Type," +
  "Line: Product ID,Line: Variant ID,Line: SKU,Line: Title,Line: Quantity,Line: Price," +
  "Line: Product Tags,Line: Product Type";

function orderRow(opts: { id: string; createdAt: string; total: string }): string {
  return [
    opts.id,
    `#${opts.id}`,
    opts.createdAt,
    opts.createdAt,
    "INR",
    opts.total,
    opts.total,
    "0.00",
    "0.00",
    "IN",
    "IN",
    "paid",
    "synthtest-customer-1",
    "",
    "",
    "",
    "Line Item",
    "prod-synth-1",
    "var-synth-1",
    "SKU-SYNTH-1",
    "Synthetic Test Product",
    "1",
    opts.total,
    "",
    "Jewellery",
  ]
    .map((v) => `"${v.replace(/"/g, '""')}"`)
    .join(",");
}

describe("reconstructShopifyNormalizedAsOf", () => {
  it("parses an archived orders_csv_import payload through B5's own parseMatrixifyCsv + normalizeMatrixifyOrderGroup and C1's own normalizeShopifyOrder", async () => {
    const csv = [
      CSV_HEADER,
      orderRow({ id: "5000000001", createdAt: "2026-08-01 10:00:00 +0530", total: "1999.00" }),
    ].join("\n");

    const bucket = createFakeArchiveBucket();
    const archive = new GcsRawArchiveStore(bucket);
    await archive.archive({
      source: "shopify",
      day: "2026-08-01",
      resource: "orders_csv_import",
      runId: "run-a",
      payload: csv,
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

    const state = await reconstructShopifyNormalizedAsOf(reader, {
      reportingTimezone: "Asia/Kolkata",
      reportingCurrency: "INR",
      accountId: "act_test",
      knownGaps: [],
      fromDay: "2026-07-28",
      toDay: "2026-08-05",
    });

    expect(state.orders).toHaveLength(1);
    expect(state.orders[0].orderId).toBe("5000000001");
    expect(state.orders[0].totalPrice.amountMinorUnits).toBe(199900);
    // "2026-08-01 10:00:00 +0530" is well after IST midnight, so the reporting day matches.
    expect(state.orders[0].reportingDay).toBe("2026-08-01");
    // No PII surfaces beyond the synthetic customerId this test itself supplied.
    expect(state.orders[0].customerId).toBe("synthtest-customer-1");

    // Coverage rows exist for every day in the requested range, none flagged (no knownGaps).
    expect(state.coverageByDay.size).toBe(9); // 2026-07-28 .. 2026-08-05 inclusive
    expect(state.coverageByDay.get("2026-08-01")?.hasCoverageGap).toBe(false);
    expect(state.coverageByDay.get("2026-08-01")?.ordersObserved).toBe(1);
  });

  it("flags a day inside a supplied knownGaps range as a coverage gap", async () => {
    const bucket = createFakeArchiveBucket();
    const archive = new GcsRawArchiveStore(bucket);
    const syncRuns = createFakeSyncRunSource([]);
    const reader = await PointInTimeArchiveReader.create({
      asOfInstant: new Date("2026-08-30T00:00:00Z"),
      archive,
      listable: bucket,
      syncRuns,
    });

    const state = await reconstructShopifyNormalizedAsOf(reader, {
      reportingTimezone: "Asia/Kolkata",
      reportingCurrency: "INR",
      accountId: "act_test",
      knownGaps: [
        { startDate: "2025-12-14", endDateExclusive: "2026-07-02", reason: "synthetic test gap" },
      ],
      fromDay: "2026-01-01",
      toDay: "2026-01-03",
    });

    expect(state.orders).toHaveLength(0);
    expect(state.coverageByDay.get("2026-01-01")?.hasCoverageGap).toBe(true);
    expect(state.coverageByDay.get("2026-01-01")?.gapReason).toBe("synthetic test gap");
  });
});
