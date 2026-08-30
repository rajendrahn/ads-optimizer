import { describe, expect, it } from "vitest";
import { computeReconciliationWindow } from "./reconciliationWindow.ts";

describe("computeReconciliationWindow — §9.4", () => {
  it("throws when there is no watermark yet", () => {
    expect(() =>
      computeReconciliationWindow({
        watermark: null,
        today: "2026-08-30",
        reconciliationDays: 14,
        mode: "incremental",
      }),
    ).toThrow(/no watermark/);
  });

  it("uses the rolling window when the watermark is recent (within the window)", () => {
    const result = computeReconciliationWindow({
      watermark: "2026-08-29", // yesterday — incremental start would be today
      today: "2026-08-30",
      reconciliationDays: 14,
      mode: "incremental",
    });
    // rolling window wins: today - 13 days
    expect(result).toEqual({
      startDate: "2026-08-17",
      endDate: "2026-08-30",
      kind: "incremental_plus_rolling",
    });
  });

  it("uses the incremental start when the watermark is older than the rolling window", () => {
    const result = computeReconciliationWindow({
      watermark: "2026-07-01", // ~60 days stale
      today: "2026-08-30",
      reconciliationDays: 14,
      mode: "incremental",
    });
    expect(result).toEqual({
      startDate: "2026-07-02", // watermark + 1
      endDate: "2026-08-30",
      kind: "incremental_plus_rolling",
    });
  });

  it("still applies the rolling window even when the watermark is exactly today", () => {
    const result = computeReconciliationWindow({
      watermark: "2026-08-30",
      today: "2026-08-30",
      reconciliationDays: 14,
      mode: "incremental",
    });
    expect(result.startDate).toBe("2026-08-17");
    expect(result.endDate).toBe("2026-08-30");
  });

  it("boundary: watermark exactly reconciliationDays - 1 back ties with the rolling start", () => {
    const result = computeReconciliationWindow({
      watermark: "2026-08-16", // watermark + 1 = 2026-08-17 = rollingStart exactly
      today: "2026-08-30",
      reconciliationDays: 14,
      mode: "incremental",
    });
    expect(result.startDate).toBe("2026-08-17");
  });

  it("deep mode covers deepReconciliationDays regardless of the watermark", () => {
    const result = computeReconciliationWindow({
      watermark: "2026-08-29",
      today: "2026-08-30",
      reconciliationDays: 14,
      mode: "deep",
      deepReconciliationDays: 60,
    });
    expect(result).toEqual({
      startDate: "2026-07-02", // today - 59 days
      endDate: "2026-08-30",
      kind: "deep",
    });
  });

  it("deep mode throws without deepReconciliationDays", () => {
    expect(() =>
      computeReconciliationWindow({
        watermark: "2026-08-29",
        today: "2026-08-30",
        reconciliationDays: 14,
        mode: "deep",
      }),
    ).toThrow(/deepReconciliationDays/);
  });

  it("rejects a non-positive reconciliationDays", () => {
    expect(() =>
      computeReconciliationWindow({
        watermark: "2026-08-29",
        today: "2026-08-30",
        reconciliationDays: 0,
        mode: "incremental",
      }),
    ).toThrow(/reconciliationDays/);
  });

  it("crosses a year boundary correctly", () => {
    const result = computeReconciliationWindow({
      watermark: "2025-12-20",
      today: "2026-01-05",
      reconciliationDays: 14,
      mode: "incremental",
    });
    // rollingStart = 2026-01-05 - 13d = 2025-12-23; incrementalStart = 2025-12-21
    expect(result.startDate).toBe("2025-12-21");
    expect(result.endDate).toBe("2026-01-05");
  });
});
