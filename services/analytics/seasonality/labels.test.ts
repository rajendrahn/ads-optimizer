import { describe, expect, it } from "vitest";
import type { SeasonalCalendarWindow } from "@shared/schema/index.ts";
import { isOffSeasonDay, labelsForRange, rangesOverlap, sameRegime } from "./labels.ts";

function window(
  label: string,
  startDay: string,
  endDay: string,
  overrides: Partial<SeasonalCalendarWindow> = {},
): SeasonalCalendarWindow {
  return {
    label,
    startDay,
    endDay,
    year: 2025,
    confidence: "confirmed",
    source: "test fixture",
    notes: null,
    sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    computedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("rangesOverlap", () => {
  it("true for identical ranges", () => {
    expect(
      rangesOverlap(
        { startDay: "2025-10-19", endDay: "2025-10-23" },
        { startDay: "2025-10-19", endDay: "2025-10-23" },
      ),
    ).toBe(true);
  });

  it("true when one range's start falls inside the other", () => {
    expect(
      rangesOverlap(
        { startDay: "2025-10-01", endDay: "2025-10-20" },
        { startDay: "2025-10-19", endDay: "2025-10-23" },
      ),
    ).toBe(true);
  });

  it("true for a single-day range touching the boundary", () => {
    expect(
      rangesOverlap(
        { startDay: "2025-10-23", endDay: "2025-10-23" },
        { startDay: "2025-10-19", endDay: "2025-10-23" },
      ),
    ).toBe(true);
  });

  it("false for adjacent, non-overlapping ranges (dhanteras/diwali disjoint by design)", () => {
    expect(
      rangesOverlap(
        { startDay: "2025-10-17", endDay: "2025-10-18" },
        { startDay: "2025-10-19", endDay: "2025-10-23" },
      ),
    ).toBe(false);
  });

  it("false for ranges far apart", () => {
    expect(
      rangesOverlap(
        { startDay: "2025-01-01", endDay: "2025-01-05" },
        { startDay: "2025-10-19", endDay: "2025-10-23" },
      ),
    ).toBe(false);
  });
});

describe("labelsForRange", () => {
  const windows = [
    window("dhanteras", "2025-10-17", "2025-10-18"),
    window("diwali", "2025-10-19", "2025-10-23"),
    window("wedding_season", "2025-11-15", "2026-02-15"),
  ];

  it("returns every label the query range overlaps, sorted", () => {
    // A window that spans both dhanteras and the start of diwali.
    expect(labelsForRange(windows, { startDay: "2025-10-18", endDay: "2025-10-20" })).toEqual([
      "dhanteras",
      "diwali",
    ]);
  });

  it("returns [] for a pure off-season range", () => {
    expect(labelsForRange(windows, { startDay: "2025-06-01", endDay: "2025-06-07" })).toEqual([]);
  });

  it("matches the interface's own documented example — dhanteras without diwali", () => {
    expect(labelsForRange(windows, { startDay: "2025-11-16", endDay: "2025-11-16" })).toEqual([
      "wedding_season",
    ]);
    expect(labelsForRange(windows, { startDay: "2025-10-17", endDay: "2025-10-17" })).toEqual([
      "dhanteras",
    ]);
  });

  it("dedupes multiple occurrences of the same label", () => {
    const twoYears = [
      window("diwali", "2025-10-19", "2025-10-23"),
      window("diwali", "2026-11-07", "2026-11-10"),
    ];
    expect(labelsForRange(twoYears, { startDay: "2025-01-01", endDay: "2026-12-31" })).toEqual([
      "diwali",
    ]);
  });
});

describe("isOffSeasonDay", () => {
  const windows = [window("diwali", "2025-10-19", "2025-10-23")];

  it("false for a day inside a labeled window", () => {
    expect(isOffSeasonDay(windows, "2025-10-20")).toBe(false);
  });

  it("true for a day outside every labeled window", () => {
    expect(isOffSeasonDay(windows, "2025-07-15")).toBe(true);
  });
});

describe("sameRegime", () => {
  it("true for two empty (off-season) sets", () => {
    expect(sameRegime([], [])).toBe(true);
  });

  it("true for equal sets regardless of order", () => {
    expect(sameRegime(["diwali", "wedding_season"], ["wedding_season", "diwali"])).toBe(true);
  });

  it("false when one set is empty and the other is not", () => {
    expect(sameRegime([], ["diwali"])).toBe(false);
  });

  it("false for different label sets", () => {
    expect(sameRegime(["diwali"], ["navratri"])).toBe(false);
  });
});
