import { describe, expect, it } from "vitest";
import { computeShopifyOrdersGap } from "./gap.ts";

describe("computeShopifyOrdersGap", () => {
  it("returns no gap when there is no backfill yet", () => {
    expect(
      computeShopifyOrdersGap({ backfillCoverageThroughDate: null, today: "2026-08-30" }),
    ).toEqual([]);
  });

  it("reproduces the real, accepted gap as of today (2026-08-30)", () => {
    const gaps = computeShopifyOrdersGap({
      backfillCoverageThroughDate: "2025-12-13",
      today: "2026-08-30",
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].startDate).toBe("2025-12-14");
    // 60-day window back from 2026-08-30 (inclusive of today) starts 2026-07-02.
    expect(gaps[0].endDateExclusive).toBe("2026-07-02");
    expect(gaps[0].reason).toMatch(/2025-12-13/);
    expect(gaps[0].reason).toMatch(/read_orders/);
  });

  it("returns no gap once the backfill reaches into the currently-reachable window", () => {
    const gaps = computeShopifyOrdersGap({
      backfillCoverageThroughDate: "2026-07-15", // inside the last 60 days of "today"
      today: "2026-08-30",
    });
    expect(gaps).toEqual([]);
  });

  it("returns no gap at the exact boundary (backfill reaches exactly the earliest reachable day)", () => {
    const gaps = computeShopifyOrdersGap({
      backfillCoverageThroughDate: "2026-07-02",
      today: "2026-08-30",
    });
    expect(gaps).toEqual([]);
  });

  it("widens as 'today' advances with no new backfill (the documented growth property)", () => {
    const gapNow = computeShopifyOrdersGap({
      backfillCoverageThroughDate: "2025-12-13",
      today: "2026-08-30",
    });
    const gapLater = computeShopifyOrdersGap({
      backfillCoverageThroughDate: "2025-12-13",
      today: "2026-09-30",
    });
    expect(gapLater[0].endDateExclusive > gapNow[0].endDateExclusive).toBe(true);
  });

  it("respects a custom reachableWindowDays", () => {
    const gaps = computeShopifyOrdersGap({
      backfillCoverageThroughDate: "2026-01-01",
      today: "2026-08-30",
      reachableWindowDays: 30,
    });
    expect(gaps[0].endDateExclusive).toBe("2026-08-01");
  });
});
