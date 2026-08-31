// Blended account efficiency (MER) — B7 spec's third binding consequence of near-zero
// attribution coverage: "Emit an account-level blended efficiency metric that needs no
// attribution at all — total Shopify revenue ÷ total Meta spend per reporting window... At
// ~0% attribution coverage this is the only honest account-level read on whether the ad spend
// is working, and it is immune to the tagging problem entirely."
//
// Deliberately trivial and deliberately NOT a reconciliation of Meta-attributed vs.
// Shopify-attributed figures (§6.2 forbids merging those; out of scope for this whole step) —
// this divides one account total by another, using neither attribution. Money in, money out;
// no order-to-ad join anywhere in this file. Currency mismatches are the caller's problem to
// prevent (both totals must already be in the same reporting currency — §5.2) — this function
// has no currency of its own to check.

/** Money is integer minor units throughout the codebase (§0.2) — this function divides two
 * minor-unit totals, which is currency-invariant as long as both are the same currency (their
 * ratio is dimensionless), so no currency-code parameter is needed here. */
export function computeBlendedMer(input: {
  totalShopifyRevenueMinorUnits: number;
  totalMetaSpendMinorUnits: number;
}): number | null {
  const { totalShopifyRevenueMinorUnits, totalMetaSpendMinorUnits } = input;
  if (totalMetaSpendMinorUnits === 0) return null; // undefined, not zero/infinite
  return totalShopifyRevenueMinorUnits / totalMetaSpendMinorUnits;
}
