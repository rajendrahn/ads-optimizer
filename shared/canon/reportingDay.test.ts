// toReportingDay / reportingDayToUtcRange — pure, no Firestore, no emulator.
//
// The Done-when line for this step is specific: "Day-boundary tests pass for instants either
// side of midnight in the reporting timezone, and across a DST transition in a non-IST
// timezone to prove the helper is not hardcoded." Asia/Kolkata (the account's configured
// §5.1 timezone) never observes DST, so a suite that only exercised it could pass even with an
// implementation hardcoded to a fixed +5:30 offset. The DST-transition tests below use
// America/New_York, verified against Node's own Intl/ICU data (not asserted from memory) to
// actually transition EST -> EDT on 2026-03-08 and EDT -> EST on 2026-11-01 — see the
// transition-scan commands run during planning, reproduced in comments below.

import { describe, expect, it } from "vitest";
import { addCalendarDays, reportingDayToUtcRange, toReportingDay } from "./reportingDay.ts";

describe("toReportingDay — day boundary in the reporting timezone (Asia/Kolkata, +5:30, no DST)", () => {
  it("an instant just before local midnight lands on the earlier day", () => {
    // 2026-08-30T18:29:59.000Z = 2026-08-30T23:59:59+05:30 — still August 30 in Kolkata.
    const instant = new Date("2026-08-30T18:29:59.000Z");
    expect(toReportingDay(instant, "Asia/Kolkata")).toBe("2026-08-30");
  });

  it("an instant exactly at local midnight lands on the later day", () => {
    // 2026-08-30T18:30:00.000Z = 2026-08-31T00:00:00+05:30 — the instant local midnight ticks
    // over. One second earlier landed on Aug 30 (previous test); this one must land on Aug 31.
    const instant = new Date("2026-08-30T18:30:00.000Z");
    expect(toReportingDay(instant, "Asia/Kolkata")).toBe("2026-08-31");
  });

  it("reportingDayToUtcRange is the exact inverse for a non-DST zone: a fixed 24h, +5:30-shifted span", () => {
    const { startUtc, endUtcExclusive } = reportingDayToUtcRange("2026-08-30", "Asia/Kolkata");
    expect(startUtc.toISOString()).toBe("2026-08-29T18:30:00.000Z");
    expect(endUtcExclusive.toISOString()).toBe("2026-08-30T18:30:00.000Z");
    expect(endUtcExclusive.getTime() - startUtc.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("toReportingDay / reportingDayToUtcRange across a real DST transition (America/New_York, non-IST)", () => {
  // Verified via Intl against Node's own tzdata during planning:
  //   scanning March 2026, America/New_York's UTC offset changes from EST (-05:00) to
  //   EDT (-04:00) on 2026-03-08 — the US spring-forward, clocks 01:59:59 -> 03:00:00 local.
  //   scanning November 2026, it changes back EDT -> EST on 2026-11-01 — the US fall-back,
  //   clocks 01:59:59 -> 01:00:00 local (the 1am-2am hour repeats).
  // A hardcoded-offset implementation (or one that computes the offset once and reuses it)
  // would fail every assertion below that spans the transition.

  it("spring-forward day (2026-03-08) is 23 real hours long, not 24", () => {
    const { startUtc, endUtcExclusive } = reportingDayToUtcRange("2026-03-08", "America/New_York");
    // Midnight AT THE START of March 8 is still EST (-05:00): 05:00Z = 00:00 local.
    expect(startUtc.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    // Midnight at the START of March 9 is already EDT (-04:00): 04:00Z = 00:00 local — the
    // transition happened at 2am local on the 8th, before this next-midnight boundary.
    expect(endUtcExclusive.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(endUtcExclusive.getTime() - startUtc.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("fall-back day (2026-11-01) is 25 real hours long", () => {
    const { startUtc, endUtcExclusive } = reportingDayToUtcRange("2026-11-01", "America/New_York");
    // Midnight at the start of Nov 1 is still EDT (-04:00): 04:00Z = 00:00 local.
    expect(startUtc.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    // Midnight at the start of Nov 2 is already EST (-05:00): 05:00Z = 00:00 local — the
    // transition happened at 2am local on the 1st.
    expect(endUtcExclusive.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(endUtcExclusive.getTime() - startUtc.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("toReportingDay agrees with reportingDayToUtcRange on both sides of the spring-forward transition", () => {
    const tz = "America/New_York";
    // Just before 2am local on March 8 (still EST, -05:00): 06:59:00Z = 01:59:00 local.
    const beforeTransition = new Date("2026-03-08T06:59:00.000Z");
    // Just after the jump to 3am local (now EDT, -04:00): 07:01:00Z = 03:01:00 local. Both
    // instants are on the same calendar day in NY — the transition skips 2:00-2:59 local, it
    // does not cross midnight — so both must resolve to the same reporting day.
    const afterTransition = new Date("2026-03-08T07:01:00.000Z");
    expect(toReportingDay(beforeTransition, tz)).toBe("2026-03-08");
    expect(toReportingDay(afterTransition, tz)).toBe("2026-03-08");

    // And the instant one second before the reporting day rolls over to March 9 must be
    // *inside* [startUtc, endUtcExclusive) for 2026-03-08, using the freshly-in-effect EDT
    // offset — proving the day boundary itself, not just an arbitrary instant, is DST-correct.
    const { endUtcExclusive } = reportingDayToUtcRange("2026-03-08", tz);
    const justBeforeRollover = new Date(endUtcExclusive.getTime() - 1);
    const atRollover = endUtcExclusive;
    expect(toReportingDay(justBeforeRollover, tz)).toBe("2026-03-08");
    expect(toReportingDay(atRollover, tz)).toBe("2026-03-09");
  });
});

describe("round-trip and error handling", () => {
  it("toReportingDay(instant) is contained in reportingDayToUtcRange(that day) for a range of instants and zones", () => {
    const zones = ["Asia/Kolkata", "America/New_York", "Europe/London", "UTC"];
    const instants = [
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-06-15T12:34:56.000Z"),
      new Date("2026-12-31T23:59:59.999Z"),
    ];
    for (const tz of zones) {
      for (const instant of instants) {
        const day = toReportingDay(instant, tz);
        const { startUtc, endUtcExclusive } = reportingDayToUtcRange(day, tz);
        expect(instant.getTime()).toBeGreaterThanOrEqual(startUtc.getTime());
        expect(instant.getTime()).toBeLessThan(endUtcExclusive.getTime());
      }
    }
  });

  it("throws on an invalid IANA timezone rather than silently falling back to UTC or local", () => {
    expect(() => toReportingDay(new Date(), "Not/AZone")).toThrow();
    expect(() => reportingDayToUtcRange("2026-01-01", "Not/AZone")).toThrow();
  });

  it("throws on a malformed reporting-day string", () => {
    // ReportingDay is a plain `string` at the type level (a regex-validated zod schema, not a
    // branded type), so this is a runtime-only check — the type system doesn't catch it.
    expect(() => reportingDayToUtcRange("2026/01/01", "UTC")).toThrow();
  });

  it("throws on an invalid Date instant", () => {
    expect(() => toReportingDay(new Date("not a date"), "UTC")).toThrow();
  });
});

describe("addCalendarDays — pure calendar arithmetic, no timezone", () => {
  it("adds within a month", () => {
    expect(addCalendarDays("2026-08-10", 5)).toBe("2026-08-15");
  });

  it("subtracts within a month via a negative delta", () => {
    expect(addCalendarDays("2026-08-10", -5)).toBe("2026-08-05");
  });

  it("rolls over a month boundary", () => {
    expect(addCalendarDays("2026-08-30", 3)).toBe("2026-09-02");
  });

  it("rolls over a year boundary", () => {
    expect(addCalendarDays("2026-12-30", 3)).toBe("2027-01-02");
  });

  it("rolls backward over a month boundary", () => {
    expect(addCalendarDays("2026-09-01", -2)).toBe("2026-08-30");
  });

  it("delta of 0 is a no-op", () => {
    expect(addCalendarDays("2026-08-10", 0)).toBe("2026-08-10");
  });

  it("throws on a malformed reporting-day string", () => {
    expect(() => addCalendarDays("2026/08/10", 1)).toThrow();
  });
});
