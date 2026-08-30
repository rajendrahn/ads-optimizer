// Budget ownership determination — §4.1/§7.1: "Budget decisions resolve at the budget owner.
// The system already determines whether budget is owned at campaign or ad-set level; that
// owner is the decision unit." IMPLEMENTATION_PLAN.md's B2 spec: "If it is ambiguous for a
// given campaign structure, store the ambiguity explicitly rather than guessing — D1 needs to
// know when it does not know."
//
// Meta's own rule: a campaign either owns its budget (Campaign Budget Optimization / an
// Advantage+ campaign's budget) — signalled by `daily_budget`/`lifetime_budget` being present
// on the *campaign* object — or each ad set owns its own, signalled the same way on the *ad
// set* object. Normally exactly one of the two carries a budget. This module treats "exactly
// one carries a budget" as the only unambiguous case and stores `ownerLevel: "UNKNOWN"`
// (`shared/schema/common.ts`'s `budgetOwnership`) for the other two logically possible cases:
// both report a budget (a conflicting signal) and neither does (no signal to resolve from).
//
// Validated against this account live (read-only, no write): of 410 campaigns / 534 ad sets,
// 369 campaigns own budget outright, 37 have a single ad set that owns it, and 4 are old
// PAUSED campaigns with literally zero ad sets returned by Meta (their ad sets are gone —
// Meta's API refuses to even query "deleted objects") and no budget of their own — a live,
// naturally-occurring example of the "neither" case, not a hypothetical one. Zero conflicts
// (both levels reporting a budget) were observed, but the API does not forbid that structurally
// (e.g. a stale ad-set budget left over from toggling CBO off), so it is still handled.

import type { BudgetOwnership } from "@shared/schema/index.ts";

export interface RawMetaBudgetFields {
  daily_budget?: string | null;
  lifetime_budget?: string | null;
}

function hasBudget(raw: RawMetaBudgetFields): boolean {
  return raw.daily_budget != null || raw.lifetime_budget != null;
}

/**
 * Meta returns `daily_budget`/`lifetime_budget` already in the account's minor currency unit
 * as a decimal-free integer string (e.g. `"80000"` for a ₹800.00/day budget on this INR
 * account — confirmed live), not a decimal amount like `"800.00"`. Parsed as a plain integer,
 * deliberately never through `shared/canon/money.ts`'s `parseDecimalToMinorUnits` — that
 * helper is for genuinely decimal money strings (e.g. insights spend), a different
 * representation than this field uses.
 */
function parseMinorUnits(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`budgetOwnership: expected an integer minor-units string, got "${value}"`);
  }
  return n;
}

function unknownBudget(currency: string): BudgetOwnership {
  return {
    ownerLevel: "UNKNOWN",
    dailyBudgetMinorUnits: null,
    lifetimeBudgetMinorUnits: null,
    currency,
  };
}

/**
 * A campaign's *own* budget, considered in isolation — `null` when the campaign itself
 * reports none (which does not yet mean an ad set owns it; see
 * `determineCampaignBudgetGivenChildren`, which has the ad-set context needed to tell "ad set
 * owns it" apart from "nobody does").
 */
export function determineCampaignBudget(
  campaign: RawMetaBudgetFields,
  currency: string,
): BudgetOwnership | null {
  if (!hasBudget(campaign)) return null;
  return {
    ownerLevel: "CAMPAIGN",
    dailyBudgetMinorUnits: parseMinorUnits(campaign.daily_budget),
    lifetimeBudgetMinorUnits: parseMinorUnits(campaign.lifetime_budget),
    currency,
  };
}

/**
 * The value to store on `metaCampaigns/{id}.budget` (and the equivalent field on that
 * campaign's `metaEntitySnapshots` doc). Needs the campaign's own ad sets to distinguish
 * "ad-set level owns it, correctly `null` here" from "nobody's config shows a budget at all,
 * genuinely unknown" — both look like "the campaign itself has no budget" in isolation.
 */
export function determineCampaignBudgetGivenChildren(
  campaign: RawMetaBudgetFields,
  childAdsets: RawMetaBudgetFields[],
  currency: string,
): BudgetOwnership | null {
  const ownBudget = determineCampaignBudget(campaign, currency);
  if (ownBudget) return ownBudget;
  if (childAdsets.length === 0) return unknownBudget(currency); // e.g. this account's 4 orphans
  const anyAdsetOwns = childAdsets.some((a) => hasBudget(a));
  if (anyAdsetOwns) return null; // ad-set level owns it — correct, not ambiguous
  return unknownBudget(currency); // campaign has adsets, none of which report a budget either
}

export interface DetermineAdsetBudgetInput {
  adset: RawMetaBudgetFields;
  /** Whether this ad set's own parent campaign owns budget — i.e.
   * `determineCampaignBudget(campaign, ...) !== null`. */
  campaignOwnsBudget: boolean;
  currency: string;
}

/**
 * One ad set's own budget ownership, given its parent campaign's determination. Four cases:
 *  - campaign owns, ad set reports none  -> ad set does not own (`null`) — consistent; the
 *    campaign is the decision unit (§4.1).
 *  - campaign doesn't own, ad set reports one -> ad set owns — the ordinary non-CBO case.
 *  - campaign owns AND the ad set ALSO reports one -> conflicting signals -> `UNKNOWN`.
 *  - campaign doesn't own AND the ad set reports none either -> no signal at all -> `UNKNOWN`.
 */
export function determineAdsetBudget(input: DetermineAdsetBudgetInput): BudgetOwnership | null {
  const adsetHasBudget = hasBudget(input.adset);

  if (input.campaignOwnsBudget && !adsetHasBudget) {
    return null;
  }
  if (!input.campaignOwnsBudget && adsetHasBudget) {
    return {
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: parseMinorUnits(input.adset.daily_budget),
      lifetimeBudgetMinorUnits: parseMinorUnits(input.adset.lifetime_budget),
      currency: input.currency,
    };
  }
  return unknownBudget(input.currency);
}
