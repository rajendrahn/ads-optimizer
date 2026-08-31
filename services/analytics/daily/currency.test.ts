import { describe, expect, it } from "vitest";
import { normalizeAmountToReportingCurrency, normalizeToReportingCurrency } from "./currency.ts";

describe("normalizeToReportingCurrency", () => {
  it("returns a recorded 1:1 FX rate when the source currency already matches the reporting currency", () => {
    const result = normalizeToReportingCurrency(
      { amountMinorUnits: 12345, currency: "INR" },
      "INR",
    );
    expect(result).toEqual({
      amountMinorUnits: 12345,
      currency: "INR",
      sourceAmountMinorUnits: 12345,
      sourceCurrency: "INR",
      fxRateToReportingCurrency: 1,
      fxRateSource: "same_currency_no_conversion",
    });
  });

  it("throws rather than inventing an FX rate when the currencies genuinely differ", () => {
    expect(() =>
      normalizeToReportingCurrency({ amountMinorUnits: 100, currency: "USD" }, "INR"),
    ).toThrow(/USD.*INR/);
  });
});

describe("normalizeAmountToReportingCurrency", () => {
  it("is equivalent to building the Money value first", () => {
    expect(normalizeAmountToReportingCurrency(77384, "INR", "INR")).toEqual(
      normalizeToReportingCurrency({ amountMinorUnits: 77384, currency: "INR" }, "INR"),
    );
  });
});
