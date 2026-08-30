// Money canon — §0.2: "Money: Integer minor units (paise), never floats." §5.2: "Store an
// explicit currency code on every money field."
//
// `shared/schema/common.ts`'s `moneyMinorUnits` zod schema already validates the *shape*
// (`{ amountMinorUnits: integer, currency: 3-letter code }`) at the Firestore read/write
// boundary. This module is the arithmetic and parsing layer everything else uses so that no
// later step reaches for `parseFloat(x) * 100` — that expression alone can silently produce
// `1998.9999999999998` for `19.99 * 100` in JS, exactly the float drift §0.2 exists to rule
// out. Every conversion here works on the decimal string's digits directly, never through a
// floating-point intermediate.

import { moneyMinorUnits, type Money } from "../schema/common.ts";

/**
 * ISO 4217 minor-unit exponents that are NOT the default of 2. Zero-decimal currencies (JPY,
 * KRW, ...) and three-decimal currencies (BHD, KWD, OMR, ...) are the two exceptions that
 * exist in practice; everything else — including INR, the reporting currency (§5.2) — uses 2.
 * Extend this table if a presentment currency outside it is ever seen (§5.2 allows orders to
 * settle in a non-reporting currency).
 */
const MINOR_UNIT_EXPONENT_OVERRIDES: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
};

export function getMinorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2;
}

/** Constructs a validated `Money` value. Throws (via zod) on a non-integer amount. */
export function makeMoney(amountMinorUnits: number, currency: string): Money {
  return moneyMinorUnits.parse({ amountMinorUnits, currency });
}

export function zeroMoney(currency: string): Money {
  return makeMoney(0, currency);
}

function assertSameCurrency(a: Money, b: Money, op: string): void {
  if (a.currency !== b.currency) {
    throw new Error(
      `${op}: currency mismatch (${a.currency} vs ${b.currency}) — money must never be mixed across currencies without an explicit, recorded FX conversion (§5.2)`,
    );
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "addMoney");
  return makeMoney(a.amountMinorUnits + b.amountMinorUnits, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b, "subtractMoney");
  return makeMoney(a.amountMinorUnits - b.amountMinorUnits, a.currency);
}

export function negateMoney(a: Money): Money {
  return makeMoney(-a.amountMinorUnits, a.currency);
}

/** Sums a list of `Money` values, all of which must already share `currency`. */
export function sumMoney(items: readonly Money[], currency: string): Money {
  return items.reduce((acc, item) => addMoney(acc, item), zeroMoney(currency));
}

/** -1 if a < b, 0 if equal, 1 if a > b. Throws on a currency mismatch. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b, "compareMoney");
  if (a.amountMinorUnits < b.amountMinorUnits) return -1;
  if (a.amountMinorUnits > b.amountMinorUnits) return 1;
  return 0;
}

/**
 * Parses a decimal-string amount (as returned by the Meta and Shopify APIs, e.g. `"199.00"`
 * or `"19.5"`) into integer minor units for `currency`, entirely through string/integer
 * arithmetic — never `parseFloat(x) * 10^n`, which is the float-drift trap this module exists
 * to avoid. Throws on a malformed string or on more fractional digits than the currency's
 * minor-unit exponent allows (silently truncating a real sub-unit amount would be a silent
 * data-corrupting default of exactly the kind §5 warns against).
 */
export function parseDecimalToMinorUnits(amountDecimal: string, currency: string): Money {
  const trimmed = amountDecimal.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`parseDecimalToMinorUnits: "${amountDecimal}" is not a valid decimal amount`);
  }
  const [, sign, wholePart, fractionPartRaw = ""] = match;
  const exponent = getMinorUnitExponent(currency);
  if (fractionPartRaw.length > exponent) {
    throw new Error(
      `parseDecimalToMinorUnits: "${amountDecimal}" has more fractional digits than ${currency} allows (${exponent})`,
    );
  }
  const fractionPart = fractionPartRaw.padEnd(exponent, "0");
  const digits = `${wholePart}${fractionPart}`;
  // BigInt keeps this exact for arbitrarily large amounts before narrowing back to `number`;
  // ad spend/revenue at this account's scale never approaches Number.MAX_SAFE_INTEGER paise.
  const magnitude = BigInt(digits);
  const signedMagnitude = sign === "-" ? -magnitude : magnitude;
  return makeMoney(Number(signedMagnitude), currency);
}

/** The inverse of `parseDecimalToMinorUnits`: minor units back to a decimal string, for display. */
export function formatMinorUnitsAsDecimal(money: Money): string {
  const exponent = getMinorUnitExponent(money.currency);
  const negative = money.amountMinorUnits < 0;
  const digits = Math.abs(money.amountMinorUnits)
    .toString()
    .padStart(exponent + 1, "0");
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(-exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}
