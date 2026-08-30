// Money canon — pure unit tests. §0.2: integer minor units, never floats.

import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  formatMinorUnitsAsDecimal,
  getMinorUnitExponent,
  makeMoney,
  negateMoney,
  parseDecimalToMinorUnits,
  subtractMoney,
  sumMoney,
  zeroMoney,
} from "./money.ts";

describe("makeMoney / zeroMoney", () => {
  it("constructs a valid Money value", () => {
    expect(makeMoney(1050, "INR")).toEqual({ amountMinorUnits: 1050, currency: "INR" });
    expect(zeroMoney("INR")).toEqual({ amountMinorUnits: 0, currency: "INR" });
  });

  it("rejects a non-integer amount — never floats (§0.2)", () => {
    expect(() => makeMoney(10.5, "INR")).toThrow();
  });
});

describe("addMoney / subtractMoney / negateMoney / sumMoney", () => {
  it("adds and subtracts same-currency amounts", () => {
    expect(addMoney(makeMoney(1000, "INR"), makeMoney(250, "INR"))).toEqual(makeMoney(1250, "INR"));
    expect(subtractMoney(makeMoney(1000, "INR"), makeMoney(250, "INR"))).toEqual(
      makeMoney(750, "INR"),
    );
    expect(negateMoney(makeMoney(1000, "INR"))).toEqual(makeMoney(-1000, "INR"));
  });

  it("throws on a currency mismatch rather than silently coercing", () => {
    expect(() => addMoney(makeMoney(1000, "INR"), makeMoney(250, "USD"))).toThrow(
      /currency mismatch/,
    );
    expect(() => subtractMoney(makeMoney(1000, "INR"), makeMoney(250, "USD"))).toThrow(
      /currency mismatch/,
    );
  });

  it("sums a list, and an empty list sums to zero", () => {
    const items = [makeMoney(100, "INR"), makeMoney(200, "INR"), makeMoney(-50, "INR")];
    expect(sumMoney(items, "INR")).toEqual(makeMoney(250, "INR"));
    expect(sumMoney([], "INR")).toEqual(zeroMoney("INR"));
  });
});

describe("compareMoney", () => {
  it("orders same-currency amounts", () => {
    expect(compareMoney(makeMoney(100, "INR"), makeMoney(200, "INR"))).toBe(-1);
    expect(compareMoney(makeMoney(200, "INR"), makeMoney(100, "INR"))).toBe(1);
    expect(compareMoney(makeMoney(100, "INR"), makeMoney(100, "INR"))).toBe(0);
  });

  it("throws on a currency mismatch", () => {
    expect(() => compareMoney(makeMoney(100, "INR"), makeMoney(100, "USD"))).toThrow();
  });
});

describe("parseDecimalToMinorUnits — string-exact, no float intermediate", () => {
  it("parses ordinary 2-decimal amounts", () => {
    expect(parseDecimalToMinorUnits("199.00", "INR")).toEqual(makeMoney(19900, "INR"));
    expect(parseDecimalToMinorUnits("19.5", "INR")).toEqual(makeMoney(1950, "INR"));
    expect(parseDecimalToMinorUnits("0", "INR")).toEqual(makeMoney(0, "INR"));
  });

  it("avoids the classic float-drift trap: 19.99 must be exactly 1999, not 1998.9999999999998", () => {
    // parseFloat("19.99") * 100 famously evaluates to 1998.9999999999998 in JS. If this
    // module used that expression, Math.round would mask it here but a subtler amount
    // wouldn't always be so lucky — the point of this module is to never go through the float
    // intermediate at all, verified directly against BigInt-free positive assertions below.
    expect(parseDecimalToMinorUnits("19.99", "INR").amountMinorUnits).toBe(1999);
    expect(19.99 * 100).not.toBe(1999); // documents the trap this module avoids
  });

  it("handles negative amounts (refunds)", () => {
    expect(parseDecimalToMinorUnits("-50.25", "INR")).toEqual(makeMoney(-5025, "INR"));
  });

  it("respects a zero-decimal currency's exponent", () => {
    expect(getMinorUnitExponent("JPY")).toBe(0);
    expect(parseDecimalToMinorUnits("500", "JPY")).toEqual(makeMoney(500, "JPY"));
  });

  it("respects a three-decimal currency's exponent", () => {
    expect(getMinorUnitExponent("BHD")).toBe(3);
    expect(parseDecimalToMinorUnits("1.500", "BHD")).toEqual(makeMoney(1500, "BHD"));
  });

  it("throws rather than silently truncating extra fractional digits", () => {
    expect(() => parseDecimalToMinorUnits("19.999", "INR")).toThrow();
    expect(() => parseDecimalToMinorUnits("1.5", "JPY")).toThrow();
  });

  it("throws on a malformed decimal string", () => {
    expect(() => parseDecimalToMinorUnits("abc", "INR")).toThrow();
    expect(() => parseDecimalToMinorUnits("1.2.3", "INR")).toThrow();
    expect(() => parseDecimalToMinorUnits("", "INR")).toThrow();
  });
});

describe("formatMinorUnitsAsDecimal — the inverse of parseDecimalToMinorUnits", () => {
  it("round-trips 2-decimal currencies", () => {
    expect(formatMinorUnitsAsDecimal(makeMoney(19900, "INR"))).toBe("199.00");
    expect(formatMinorUnitsAsDecimal(makeMoney(1999, "INR"))).toBe("19.99");
    expect(formatMinorUnitsAsDecimal(makeMoney(5, "INR"))).toBe("0.05");
  });

  it("round-trips a zero-decimal currency", () => {
    expect(formatMinorUnitsAsDecimal(makeMoney(500, "JPY"))).toBe("500");
  });

  it("round-trips a three-decimal currency", () => {
    expect(formatMinorUnitsAsDecimal(makeMoney(1500, "BHD"))).toBe("1.500");
  });

  it("formats negative amounts with a leading minus", () => {
    expect(formatMinorUnitsAsDecimal(makeMoney(-5025, "INR"))).toBe("-50.25");
  });

  it("is the exact inverse of parseDecimalToMinorUnits for a range of amounts", () => {
    const cases: [string, string][] = [
      ["199.00", "INR"],
      ["0.01", "INR"],
      ["-42.42", "INR"],
      ["1000", "JPY"],
      ["2.750", "BHD"],
    ];
    for (const [decimal, currency] of cases) {
      const money = parseDecimalToMinorUnits(decimal, currency);
      expect(formatMinorUnitsAsDecimal(money)).toBe(decimal);
    }
  });
});
