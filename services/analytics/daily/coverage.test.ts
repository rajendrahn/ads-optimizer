import { describe, expect, it } from "vitest";
import type { SyncStateKnownGap } from "@shared/schema/index.ts";
import { computeShopifyDailyCoverage } from "./coverage.ts";

const COMPUTED_AT = new Date("2026-08-31T00:00:00Z");

describe("computeShopifyDailyCoverage", () => {
  it("produces one row per calendar day in the inclusive range, with zero counts when nothing was observed", () => {
    const rows = computeShopifyDailyCoverage({
      reportingTimezone: "Asia/Kolkata",
      accountId: "act_1",
      fromDay: "2026-08-01",
      toDay: "2026-08-03",
      ordersObservedByDay: new Map(),
      refundsObservedByDay: new Map(),
      knownGaps: [],
      computedAt: COMPUTED_AT,
    });
    expect(rows.map((r) => r.reportingDay)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    for (const r of rows) {
      expect(r.hasCoverageGap).toBe(false);
      expect(r.gapReason).toBeNull();
      expect(r.ordersObserved).toBe(0);
      expect(r.refundsObserved).toBe(0);
      expect(r.reportingTimezone).toBe("Asia/Kolkata");
    }
  });

  it("marks a day inside a known gap explicitly — the B5 Dec 2025 -> Jul 2026 hole, shaped exactly as syncState stores it", () => {
    const knownGaps: SyncStateKnownGap[] = [
      {
        startDate: "2025-12-14",
        endDateExclusive: "2026-07-02",
        reason: "matrixify/read_orders gap",
      },
    ];
    const rows = computeShopifyDailyCoverage({
      reportingTimezone: "Asia/Kolkata",
      accountId: "act_1",
      fromDay: "2025-12-13",
      toDay: "2026-07-02",
      ordersObservedByDay: new Map(),
      refundsObservedByDay: new Map(),
      knownGaps,
      computedAt: COMPUTED_AT,
    });
    const byDay = new Map(rows.map((r) => [r.reportingDay, r]));
    // Half-open [startDate, endDateExclusive): the day before the gap and the gap's own end
    // boundary are NOT flagged; every day inside is.
    expect(byDay.get("2025-12-13")?.hasCoverageGap).toBe(false);
    expect(byDay.get("2025-12-14")?.hasCoverageGap).toBe(true);
    expect(byDay.get("2025-12-14")?.gapReason).toBe("matrixify/read_orders gap");
    expect(byDay.get("2026-07-01")?.hasCoverageGap).toBe(true);
    expect(byDay.get("2026-07-02")?.hasCoverageGap).toBe(false);
  });

  it("carries through real observed order/refund counts per day", () => {
    const rows = computeShopifyDailyCoverage({
      reportingTimezone: "Asia/Kolkata",
      accountId: "act_1",
      fromDay: "2026-08-01",
      toDay: "2026-08-02",
      ordersObservedByDay: new Map([
        ["2026-08-01", 3],
        ["2026-08-02", 0],
      ]),
      refundsObservedByDay: new Map([["2026-08-01", 1]]),
      knownGaps: [],
      computedAt: COMPUTED_AT,
    });
    const byDay = new Map(rows.map((r) => [r.reportingDay, r]));
    expect(byDay.get("2026-08-01")).toMatchObject({ ordersObserved: 3, refundsObserved: 1 });
    expect(byDay.get("2026-08-02")).toMatchObject({ ordersObserved: 0, refundsObserved: 0 });
  });

  it("returns an empty array when fromDay is after toDay", () => {
    expect(
      computeShopifyDailyCoverage({
        reportingTimezone: "Asia/Kolkata",
        accountId: "act_1",
        fromDay: "2026-08-05",
        toDay: "2026-08-01",
        ordersObservedByDay: new Map(),
        refundsObservedByDay: new Map(),
        knownGaps: [],
        computedAt: COMPUTED_AT,
      }),
    ).toEqual([]);
  });

  it("stamps sourceUpdatedAt = computedAt (own computation timestamp, no natural source field)", () => {
    const rows = computeShopifyDailyCoverage({
      reportingTimezone: "Asia/Kolkata",
      accountId: "act_1",
      fromDay: "2026-08-01",
      toDay: "2026-08-01",
      ordersObservedByDay: new Map(),
      refundsObservedByDay: new Map(),
      knownGaps: [],
      computedAt: COMPUTED_AT,
    });
    expect(rows[0]?.sourceUpdatedAt).toEqual(COMPUTED_AT);
    expect(rows[0]?.computedAt).toEqual(COMPUTED_AT);
  });
});
