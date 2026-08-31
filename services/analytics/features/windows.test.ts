import { describe, expect, it } from "vitest";
import {
  ALL_WINDOW_LABELS,
  allWindowsEnding,
  dayRangeLengthDays,
  daysInRange,
  previousEquivalentWindow,
  windowEnding,
  WINDOW_LENGTH_DAYS,
} from "./windows.ts";

describe("windowEnding", () => {
  it("7d ending 2026-08-30 covers 2026-08-24..2026-08-30 (7 calendar days, inclusive)", () => {
    const w = windowEnding("7d", "2026-08-30");
    expect(w).toEqual({ startDay: "2026-08-24", endDay: "2026-08-30" });
    expect(dayRangeLengthDays(w)).toBe(7);
  });

  it("28d ending 2026-08-30 spans exactly 28 days", () => {
    const w = windowEnding("28d", "2026-08-30");
    expect(dayRangeLengthDays(w)).toBe(28);
    expect(w.startDay).toBe("2026-08-03");
  });

  it("56d window crossing a month/year boundary computes correctly", () => {
    const w = windowEnding("56d", "2026-01-15");
    expect(dayRangeLengthDays(w)).toBe(56);
    expect(w.startDay).toBe("2025-11-21");
  });
});

describe("allWindowsEnding", () => {
  it("returns all four §4.2 windows, all ending on the same day", () => {
    const windows = allWindowsEnding("2026-08-30");
    expect(Object.keys(windows).sort()).toEqual([...ALL_WINDOW_LABELS].sort());
    for (const label of ALL_WINDOW_LABELS) {
      expect(windows[label].endDay).toBe("2026-08-30");
      expect(dayRangeLengthDays(windows[label])).toBe(WINDOW_LENGTH_DAYS[label]);
    }
  });
});

describe("previousEquivalentWindow", () => {
  it("is contiguous and non-overlapping with the same length, for a 7d window", () => {
    const current = windowEnding("7d", "2026-08-30");
    const previous = previousEquivalentWindow(current);
    expect(previous).toEqual({ startDay: "2026-08-17", endDay: "2026-08-23" });
    expect(dayRangeLengthDays(previous)).toBe(7);
  });

  it("is contiguous for a 28d window too", () => {
    const current = windowEnding("28d", "2026-08-30");
    const previous = previousEquivalentWindow(current);
    expect(dayRangeLengthDays(previous)).toBe(28);
    expect(previous.endDay).toBe("2026-08-02"); // the day right before current.startDay
  });

  it("the previous-7d baseline never reaches further back than the 56d window's own start — the fact recomputeFeaturesTask.ts's single lookback query relies on", () => {
    const asOfDay = "2026-08-30";
    const window56d = windowEnding("56d", asOfDay);
    const window7d = windowEnding("7d", asOfDay);
    const previous7d = previousEquivalentWindow(window7d);
    expect(previous7d.startDay >= window56d.startDay).toBe(true);
  });
});

describe("daysInRange", () => {
  it("lists every day inclusive of both ends", () => {
    expect(daysInRange({ startDay: "2026-08-28", endDay: "2026-08-30" })).toEqual([
      "2026-08-28",
      "2026-08-29",
      "2026-08-30",
    ]);
  });

  it("a single-day range returns one day", () => {
    expect(daysInRange({ startDay: "2026-08-30", endDay: "2026-08-30" })).toEqual(["2026-08-30"]);
  });
});
