import { describe, expect, it } from "vitest";
import type { ReportingDay, SeasonalCalendarWindow } from "@shared/schema/index.ts";
import { addCalendarDays } from "@shared/canon/index.ts";
import { computeDemandIndex, MIN_SAMPLE_SIZE_FOR_INDEX } from "./demandIndex.ts";

function window(label: string, startDay: string, endDay: string): SeasonalCalendarWindow {
  return {
    label,
    startDay,
    endDay,
    year: Number(startDay.slice(0, 4)),
    confidence: "confirmed",
    source: "test fixture",
    notes: null,
    sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    computedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/** Marks every day in [from, to] as "clean" (observed, no coverage gap). */
function cleanRange(from: ReportingDay, to: ReportingDay): Map<ReportingDay, boolean> {
  const map = new Map<ReportingDay, boolean>();
  for (let day = from; day <= to; day = addCalendarDays(day, 1)) {
    map.set(day, false);
  }
  return map;
}

describe("computeDemandIndex — off-season window (no labels)", () => {
  it("is trivially 1.0 with sampleSize 0, no Firestore-shaped inputs needed", () => {
    const result = computeDemandIndex({
      labels: [],
      calendarWindows: [],
      dailyRevenueMinorUnits: new Map(),
      coverageByDay: new Map(),
    });
    expect(result).toEqual({ demandIndex: 1, sampleSize: 0, occurrences: [] });
  });
});

describe("computeDemandIndex — this account's real shape: exactly one clean occurrence", () => {
  it("returns demandIndex: null with sampleSize 1 — never a confident figure from n=1", () => {
    const calendarWindows = [window("diwali", "2025-10-19", "2025-10-23")];
    const coverageByDay = cleanRange("2025-09-01", "2025-10-23");
    const dailyRevenueMinorUnits = new Map<ReportingDay, number>();
    // Off-season baseline days: flat 100000 (₹1000) / day.
    for (
      let day = "2025-09-01" as ReportingDay;
      day <= "2025-10-18";
      day = addCalendarDays(day, 1)
    ) {
      dailyRevenueMinorUnits.set(day, 100000);
    }
    // The one Diwali occurrence: a real lift, 300000/day.
    for (
      let day = "2025-10-19" as ReportingDay;
      day <= "2025-10-23";
      day = addCalendarDays(day, 1)
    ) {
      dailyRevenueMinorUnits.set(day, 300000);
    }

    const result = computeDemandIndex({
      labels: ["diwali"],
      calendarWindows,
      dailyRevenueMinorUnits,
      coverageByDay,
    });

    expect(result.sampleSize).toBe(1);
    expect(result.demandIndex).toBeNull();
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]).toMatchObject({ usable: true, ratio: 3 });
  });
});

describe("computeDemandIndex — the honesty-critical Shopify data gap", () => {
  it("excludes gap days entirely rather than averaging across the hole", () => {
    const calendarWindows = [window("diwali", "2025-10-19", "2025-10-23")];
    // The occurrence itself falls entirely inside a coverage gap (hasCoverageGap: true) — no
    // coverage row at all is present for the baseline either, simulating "before the account's
    // earliest observed day".
    const coverageByDay = new Map<ReportingDay, boolean>([
      ["2025-10-19", true],
      ["2025-10-20", true],
      ["2025-10-21", true],
      ["2025-10-22", true],
      ["2025-10-23", true],
    ]);
    const dailyRevenueMinorUnits = new Map<ReportingDay, number>([["2025-10-20", 999999999]]);

    const result = computeDemandIndex({
      labels: ["diwali"],
      calendarWindows,
      dailyRevenueMinorUnits,
      coverageByDay,
    });

    expect(result.demandIndex).toBeNull();
    expect(result.sampleSize).toBe(0);
    expect(result.occurrences[0]).toMatchObject({
      usable: false,
      reason: expect.stringContaining("no clean"),
    });
  });

  it("skips an occurrence whose baseline is insufficiently clean, even if the occurrence itself is clean", () => {
    const calendarWindows = [window("diwali", "2025-10-19", "2025-10-23")];
    const coverageByDay = cleanRange("2025-10-19", "2025-10-23"); // occurrence is clean...
    // ...but nothing before it has a coverage row at all (simulates the account's real gap
    // immediately preceding the first clean data).
    const dailyRevenueMinorUnits = new Map<ReportingDay, number>([
      ["2025-10-19", 100000],
      ["2025-10-20", 100000],
      ["2025-10-21", 100000],
      ["2025-10-22", 100000],
      ["2025-10-23", 100000],
    ]);

    const result = computeDemandIndex({
      labels: ["diwali"],
      calendarWindows,
      dailyRevenueMinorUnits,
      coverageByDay,
    });

    expect(result.demandIndex).toBeNull();
    expect(result.sampleSize).toBe(0);
    expect(result.occurrences[0].reason).toContain("insufficient trailing off-season baseline");
  });
});

describe("computeDemandIndex — two clean occurrences", () => {
  it("returns a numeric index once sampleSize reaches MIN_SAMPLE_SIZE_FOR_INDEX", () => {
    expect(MIN_SAMPLE_SIZE_FOR_INDEX).toBe(2);
    const calendarWindows = [
      window("diwali", "2025-10-19", "2025-10-23"),
      window("diwali", "2026-11-07", "2026-11-10"),
    ];
    const coverageByDay = cleanRange("2025-09-01", "2025-10-23");
    for (
      let day = "2026-09-01" as ReportingDay;
      day <= "2026-11-10";
      day = addCalendarDays(day, 1)
    ) {
      coverageByDay.set(day, false);
    }

    const dailyRevenueMinorUnits = new Map<ReportingDay, number>();
    for (
      let day = "2025-09-01" as ReportingDay;
      day <= "2025-10-18";
      day = addCalendarDays(day, 1)
    ) {
      dailyRevenueMinorUnits.set(day, 100000);
    }
    for (
      let day = "2025-10-19" as ReportingDay;
      day <= "2025-10-23";
      day = addCalendarDays(day, 1)
    ) {
      dailyRevenueMinorUnits.set(day, 200000); // 2x baseline
    }
    for (
      let day = "2026-09-01" as ReportingDay;
      day <= "2026-11-06";
      day = addCalendarDays(day, 1)
    ) {
      dailyRevenueMinorUnits.set(day, 150000);
    }
    for (
      let day = "2026-11-07" as ReportingDay;
      day <= "2026-11-10";
      day = addCalendarDays(day, 1)
    ) {
      dailyRevenueMinorUnits.set(day, 300000); // 2x baseline
    }

    const result = computeDemandIndex({
      labels: ["diwali"],
      calendarWindows,
      dailyRevenueMinorUnits,
      coverageByDay,
    });

    expect(result.sampleSize).toBe(2);
    expect(result.demandIndex).not.toBeNull();
    expect(result.demandIndex).toBeCloseTo(2, 5);
  });
});

describe("computeDemandIndex — a baseline average of zero", () => {
  it("skips the occurrence rather than dividing by zero", () => {
    const calendarWindows = [window("test_label", "2025-10-19", "2025-10-20")];
    const coverageByDay = cleanRange("2025-09-01", "2025-10-20");
    const dailyRevenueMinorUnits = new Map<ReportingDay, number>([
      ["2025-10-19", 5000],
      ["2025-10-20", 5000],
      // every baseline day left unset -> defaults to 0 revenue, average is 0
    ]);

    const result = computeDemandIndex({
      labels: ["test_label"],
      calendarWindows,
      dailyRevenueMinorUnits,
      coverageByDay,
    });

    expect(result.demandIndex).toBeNull();
    expect(result.sampleSize).toBe(0);
    expect(result.occurrences[0].reason).toContain("zero");
  });
});
