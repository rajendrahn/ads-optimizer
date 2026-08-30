// Shared zod primitives used across every collection schema in this directory.
//
// These encode the standing conventions from IMPLEMENTATION_PLAN.md §0.2 that apply to
// every document, not just one collection: money in integer minor units, an explicit
// currency code on every money field, UTC instants, and the attribution provenance §5.3
// requires on every insight-bearing record.

import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";

/**
 * A Firestore timestamp field, normalized to a JS `Date` regardless of whether the raw
 * value came back as a Firestore `Timestamp` (reading a real document), a `Date` (writing
 * one, or a unit test constructing a fixture in memory), or an ISO-8601 string (a JSON
 * fixture). Write paths hand the Admin SDK a `Date` directly — it stores that as a
 * `Timestamp` on its own; this schema exists for *validating* values on the way in or out,
 * not for performing the conversion Firestore already does.
 */
export const firestoreTimestamp = z.preprocess((value) => {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return value;
}, z.date());

/**
 * Money in integer minor units (paise for INR) — §0.2 "Money: Integer minor units (paise),
 * never floats". `currency` is an explicit ISO 4217 code per §5.2, never assumed from
 * context, so a presentment-currency order carries its own code rather than inheriting the
 * reporting currency.
 */
export const moneyMinorUnits = z.object({
  amountMinorUnits: z.number().int(),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof moneyMinorUnits>;

/**
 * A reporting day as `YYYY-MM-DD`, always in the reporting timezone (§5.1). This is a
 * calendar day, not an instant — it has no timezone of its own, which is the point: A3's
 * `toReportingDay` is the only sanctioned way to derive one from an instant. Schemas here
 * only validate the string shape.
 */
export const reportingDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
export type ReportingDay = z.infer<typeof reportingDay>;

/**
 * §5.3: "Store both [attribution window and purchase action type] on every insight
 * document. They are part of the measurement, not configuration." Every schema that
 * carries Meta-reported conversion numbers embeds this.
 */
export const attributionProvenance = z.object({
  attributionWindow: z.string().min(1),
  purchaseActionType: z.string().min(1),
});
export type AttributionProvenance = z.infer<typeof attributionProvenance>;

/**
 * §4.1: campaign or ad-set level owns budget; when Meta's config makes that genuinely
 * ambiguous, B2 stores `ownerLevel: "UNKNOWN"` explicitly rather than guessing — "D1 needs
 * to know when it does not know."
 */
export const budgetOwnership = z.object({
  ownerLevel: z.enum(["CAMPAIGN", "ADSET", "UNKNOWN"]),
  dailyBudgetMinorUnits: z.number().int().nonnegative().nullable(),
  lifetimeBudgetMinorUnits: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3),
});
export type BudgetOwnership = z.infer<typeof budgetOwnership>;

/** §4.1: the altitude a decision or feature is resolved at. */
export const entityRef = z.object({
  type: z.enum(["AD", "ADSET", "CAMPAIGN", "CREATIVE_FAMILY", "ACCOUNT"]),
  id: z.string().min(1),
});
export type EntityRef = z.infer<typeof entityRef>;
