// C1's currency-normalization step (§5.2): "Store an explicit currency code on every money
// field. If any order settles in a presentment currency other than the reporting currency,
// store the FX rate used on that record. Never convert without recording the rate."
//
// Verified against this account's real data before writing any conversion path (per this step's
// own brief — "verify what currencies actually appear ... before building a conversion path"):
//   - Meta ad account currency: "INR" (live `GET /{accountId}?fields=currency`, confirmed by
//     both B2 and this step).
//   - Shopify shop currency: "INR" (`{ shop { currencyCode } }`, confirmed live this step; every
//     GraphQL order money field reads `shopMoney`, the shop's own currency, never a
//     `presentmentMoney` a customer might have paid in a different currency).
//   - The real Matrixify CSV export (37,172 rows, this account's actual order history): the
//     `Currency` column is `INR` on 37,170/37,172 rows — the other 2 are the two junk rows B5
//     already excludes (a blank row and a plan-limit-notice row), not real orders in another
//     currency.
//   - The reporting canon's `reportingCurrency` (§5, and A3's own notes) is "INR".
// Every currency observed in this account's real data is already the reporting currency. There
// is therefore no real conversion to perform, and — per this step's explicit instruction — no
// FX API dependency is added on the strength of a currency mismatch that has never once been
// observed. If one ever is, `normalizeToReportingCurrency` throws rather than inventing a rate:
// a silent, unverifiable conversion would be a worse defect than a loud failure an operator can
// act on.

import { makeMoney } from "@shared/canon/index.ts";
import type { Money, NormalizedMoney } from "@shared/schema/index.ts";

/**
 * Normalizes a source-currency `Money` value onto the reporting currency, recording the FX rate
 * used (§5.2) even in the identity case — a stored `1` is the honest statement "no conversion
 * was needed," not a gap in the record. Throws if the source currency actually differs from the
 * reporting currency — see module comment for why this is deliberate rather than a TODO.
 */
export function normalizeToReportingCurrency(
  source: Money,
  reportingCurrency: string,
): NormalizedMoney {
  if (source.currency === reportingCurrency) {
    return {
      amountMinorUnits: source.amountMinorUnits,
      currency: reportingCurrency,
      sourceAmountMinorUnits: source.amountMinorUnits,
      sourceCurrency: source.currency,
      fxRateToReportingCurrency: 1,
      fxRateSource: "same_currency_no_conversion",
    };
  }

  throw new Error(
    `normalizeToReportingCurrency: encountered ${source.currency}, expected ${reportingCurrency}. ` +
      `No currency other than the reporting currency has ever been observed in this account's ` +
      `real Meta or Shopify data (see services/analytics/daily/currency.ts's module comment), ` +
      `and C1 deliberately does not add an FX rate provider on spec. This must not be silently ` +
      `converted at a guessed or stale rate — an operator needs to supply a verified FX rate ` +
      `for ${source.currency} before this record can be normalized.`,
  );
}

/** Convenience: builds a `Money` from minor units + currency, then normalizes it. */
export function normalizeAmountToReportingCurrency(
  amountMinorUnits: number,
  sourceCurrency: string,
  reportingCurrency: string,
): NormalizedMoney {
  return normalizeToReportingCurrency(
    makeMoney(amountMinorUnits, sourceCurrency),
    reportingCurrency,
  );
}
