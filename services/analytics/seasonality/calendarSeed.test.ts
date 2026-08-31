import { describe, expect, it } from "vitest";
import { reportingDay } from "@shared/schema/index.ts";
import { seasonalCalendarWindowKey } from "@shared/firestore/collections.ts";
import { SEASONAL_CALENDAR_SEED_ENTRIES } from "./calendarSeed.ts";

describe("SEASONAL_CALENDAR_SEED_ENTRIES — internal consistency", () => {
  it("is non-empty and covers the five labels IMPLEMENTATION_PLAN.md C5 names explicitly", () => {
    const labels = new Set(SEASONAL_CALENDAR_SEED_ENTRIES.map((e) => e.label));
    for (const required of [
      "diwali",
      "navratri",
      "dhanteras",
      "akshaya_tritiya",
      "wedding_season",
    ]) {
      expect(labels.has(required)).toBe(true);
    }
  });

  it("every startDay/endDay is a valid reporting day, and startDay <= endDay", () => {
    for (const entry of SEASONAL_CALENDAR_SEED_ENTRIES) {
      expect(() => reportingDay.parse(entry.startDay)).not.toThrow();
      expect(() => reportingDay.parse(entry.endDay)).not.toThrow();
      expect(entry.startDay <= entry.endDay).toBe(true);
    }
  });

  it("every entry has a non-empty source citation", () => {
    for (const entry of SEASONAL_CALENDAR_SEED_ENTRIES) {
      expect(entry.source.length).toBeGreaterThan(10);
    }
  });

  it("every entry marked 'estimated' explains what was estimated, in notes", () => {
    for (const entry of SEASONAL_CALENDAR_SEED_ENTRIES) {
      if (entry.confidence === "estimated") {
        expect(
          entry.notes,
          `${entry.label}_${entry.startDay} is estimated but has no notes`,
        ).not.toBeNull();
      }
    }
  });

  it("(label, startDay) is unique — the actual Firestore document key", () => {
    const keys = SEASONAL_CALENDAR_SEED_ENTRIES.map((e) =>
      seasonalCalendarWindowKey(e.label, e.startDay),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("dhanteras and diwali windows for the same year never overlap (disjoint by design)", () => {
    const dhanteras = SEASONAL_CALENDAR_SEED_ENTRIES.filter((e) => e.label === "dhanteras");
    const diwali = SEASONAL_CALENDAR_SEED_ENTRIES.filter((e) => e.label === "diwali");
    for (const d of dhanteras) {
      for (const w of diwali) {
        if (d.year !== w.year) continue;
        const overlaps = d.startDay <= w.endDay && d.endDay >= w.startDay;
        expect(
          overlaps,
          `dhanteras ${d.startDay}..${d.endDay} overlaps diwali ${w.startDay}..${w.endDay}`,
        ).toBe(false);
      }
    }
  });

  it("has both a 2025 and a 2026 occurrence for every festival label (per-year, non-wedding-season)", () => {
    const perYearLabels = [
      "holi",
      "akshaya_tritiya",
      "raksha_bandhan",
      "ganesh_chaturthi",
      "navratri",
      "dhanteras",
      "diwali",
    ];
    for (const label of perYearLabels) {
      const years = new Set(
        SEASONAL_CALENDAR_SEED_ENTRIES.filter((e) => e.label === label).map((e) => e.year),
      );
      expect(years.has(2025), `${label} missing a 2025 entry`).toBe(true);
      expect(years.has(2026), `${label} missing a 2026 entry`).toBe(true);
    }
  });
});
