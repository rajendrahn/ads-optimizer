import { describe, expect, it } from "vitest";
import { calendarFeaturesForDay, calendarFeaturesForWindow } from "./dayFeatures.ts";

describe("calendarFeaturesForDay", () => {
  it("identifies a known Saturday as weekend", () => {
    // 2025-10-18 (Dhanteras 2025) was a Saturday.
    const f = calendarFeaturesForDay("2025-10-18");
    expect(f.dayOfWeek).toBe(6);
    expect(f.dayName).toBe("Saturday");
    expect(f.isWeekend).toBe(true);
    expect(f.monthOfYear).toBe(10);
    expect(f.monthName).toBe("October");
  });

  it("identifies a known Monday as a weekday", () => {
    // 2025-10-20 (Diwali 2025) was a Monday.
    const f = calendarFeaturesForDay("2025-10-20");
    expect(f.dayOfWeek).toBe(1);
    expect(f.dayName).toBe("Monday");
    expect(f.isWeekend).toBe(false);
  });

  it("identifies Sunday as weekend", () => {
    const f = calendarFeaturesForDay("2026-08-30"); // a Sunday
    expect(f.dayOfWeek).toBe(0);
    expect(f.isWeekend).toBe(true);
  });

  it("handles a December/January month boundary correctly", () => {
    expect(calendarFeaturesForDay("2025-12-31").monthOfYear).toBe(12);
    expect(calendarFeaturesForDay("2026-01-01").monthOfYear).toBe(1);
  });
});

describe("calendarFeaturesForWindow", () => {
  it("counts weekend/weekday days over a 7-day window", () => {
    // 2025-10-13 (Mon) .. 2025-10-19 (Sun): one full week, 2 weekend days.
    const f = calendarFeaturesForWindow({ startDay: "2025-10-13", endDay: "2025-10-19" });
    expect(f.totalDays).toBe(7);
    expect(f.weekendDayCount).toBe(2);
    expect(f.weekdayDayCount).toBe(5);
    expect(f.weekendFraction).toBeCloseTo(2 / 7);
  });

  it("a single day window has totalDays 1", () => {
    const f = calendarFeaturesForWindow({ startDay: "2025-10-18", endDay: "2025-10-18" });
    expect(f.totalDays).toBe(1);
    expect(f.monthsSpanned).toEqual([10]);
  });

  it("reports every distinct month spanned, ascending", () => {
    const f = calendarFeaturesForWindow({ startDay: "2025-10-25", endDay: "2025-11-05" });
    expect(f.monthsSpanned).toEqual([10, 11]);
  });

  it("throws when startDay is after endDay", () => {
    expect(() =>
      calendarFeaturesForWindow({ startDay: "2025-10-20", endDay: "2025-10-19" }),
    ).toThrow();
  });
});
