// attributionCoverageRatio (§6.3) — "Shopify-attributed purchases ÷ Meta-reported purchases...
// as a first-class account and entity feature. Its level is not meaningful; its drift is."
//
// Pure, entity-agnostic: the caller (C2, once it exists — this step only builds and verifies
// the calculator) has already filtered a set of resolved orders down to whatever window/entity
// it's asking about (an ad, an ad set, a campaign, or the whole account) and supplies the
// matching Meta-reported purchase count for that same window/entity. Nothing here queries
// Firestore or knows about windows — see the module-level verification script referenced in
// this step's implementation notes for how real numbers were produced against emulator data.
//
// The spec: "never silently pool [NAME_MATCH orders] with ID-resolved ones." This module takes
// that literally — `coverageRatio` (the name a reader will reach for by default) is ID-only;
// the NAME_MATCH-inclusive number is a distinctly-named sibling field, never the default.

export interface ResolvedOrderForCoverage {
  resolutionMethod: "AD_ID" | "NAME_MATCH" | "UNRESOLVED";
}

export interface AttributedPurchaseCounts {
  idResolved: number;
  nameResolved: number;
  unresolved: number;
  total: number;
}

/** Tallies a set of already-window/entity-filtered orders by resolution method. Each order
 * counts as one purchase — matching how metaInsightsDaily counts `purchases` (§6). If a caller
 * needs multi-item-order-as-multiple-purchases semantics, that's a C2 decision on top of this
 * tally, not something this function should assume. */
export function tallyResolvedOrders(
  orders: readonly ResolvedOrderForCoverage[],
): AttributedPurchaseCounts {
  let idResolved = 0;
  let nameResolved = 0;
  let unresolved = 0;
  for (const order of orders) {
    if (order.resolutionMethod === "AD_ID") idResolved++;
    else if (order.resolutionMethod === "NAME_MATCH") nameResolved++;
    else unresolved++;
  }
  return { idResolved, nameResolved, unresolved, total: orders.length };
}

export interface AttributionCoverageResult {
  shopifyAttributedPurchasesIdOnly: number;
  shopifyAttributedPurchasesIncludingNameMatch: number;
  metaReportedPurchases: number;
  /** Shopify (ID-resolved only) purchases ÷ Meta-reported purchases. `null` when
   * `metaReportedPurchases` is 0 — an undefined ratio, not a coverage of zero (a window with no
   * Meta-reported purchases at all says nothing about join quality). This is what "the coverage
   * ratio" means by default anywhere it's displayed unqualified. */
  coverageRatio: number | null;
  /** The same ratio with NAME_MATCH orders folded into the numerator too — an upper bound,
   * shown alongside (never instead of) `coverageRatio` per the spec's "never silently pool"
   * rule. Always >= coverageRatio when both are defined. */
  coverageRatioIncludingNameMatch: number | null;
}

export function computeAttributionCoverageRatio(input: {
  shopifyAttributedPurchasesIdOnly: number;
  shopifyAttributedPurchasesNameMatch: number;
  metaReportedPurchases: number;
}): AttributionCoverageResult {
  const {
    shopifyAttributedPurchasesIdOnly,
    shopifyAttributedPurchasesNameMatch,
    metaReportedPurchases,
  } = input;
  const includingNameMatch = shopifyAttributedPurchasesIdOnly + shopifyAttributedPurchasesNameMatch;

  return {
    shopifyAttributedPurchasesIdOnly,
    shopifyAttributedPurchasesIncludingNameMatch: includingNameMatch,
    metaReportedPurchases,
    coverageRatio:
      metaReportedPurchases === 0 ? null : shopifyAttributedPurchasesIdOnly / metaReportedPurchases,
    coverageRatioIncludingNameMatch:
      metaReportedPurchases === 0 ? null : includingNameMatch / metaReportedPurchases,
  };
}
