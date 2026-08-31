import { describe, expect, it } from "vitest";
import { mapNativeDayToReportingDay } from "./mapReportingDay.ts";

describe("mapNativeDayToReportingDay", () => {
  it("is the identity map when the native and reporting timezones are the same (this account's real, verified case)", () => {
    const result = mapNativeDayToReportingDay("2026-08-30", "Asia/Kolkata", "Asia/Kolkata");
    expect(result.reportingDay).toBe("2026-08-30");
  });

  it("is the identity map across a range of real calendar days, not just one", () => {
    for (const day of ["2025-01-01", "2025-04-17", "2025-12-31", "2026-02-28"]) {
      expect(mapNativeDayToReportingDay(day, "Asia/Kolkata", "Asia/Kolkata").reportingDay).toBe(
        day,
      );
    }
  });

  it("remaps a native day onto a different reporting day when the two timezones genuinely diverge", () => {
    // A native day in a timezone far behind the reporting timezone: the midpoint instant of
    // the native day (in its own timezone) can land on the previous OR next calendar day once
    // re-derived in a very different reporting timezone. This exercises the general path this
    // function takes when nativeTimezone !== reportingTimezone — not exercised by this
    // account's real, same-timezone data, but the function must still be correct here, not
    // hardcoded to identity.
    const result = mapNativeDayToReportingDay("2026-06-15", "Pacific/Kiritimati", "Etc/GMT+12");
    // Pacific/Kiritimati is UTC+14; Etc/GMT+12 is UTC-12 — a 26-hour gap, guaranteeing the
    // midpoint of the native day (in Kiritimati) falls on an earlier calendar day once viewed
    // from 26 hours behind it.
    expect(result.reportingDay).not.toBe("2026-06-15");
  });

  it("throws on an invalid IANA timezone rather than silently falling back to UTC or host-local", () => {
    expect(() => mapNativeDayToReportingDay("2026-08-30", "Not/AZone", "Asia/Kolkata")).toThrow();
    expect(() => mapNativeDayToReportingDay("2026-08-30", "Asia/Kolkata", "Not/AZone")).toThrow();
  });
});
