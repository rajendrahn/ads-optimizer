// D6 — §24: "attribution coverage" shown, always. §6.2/§6.3: Meta- and Shopify-attributed figures
// are always labelled and never merged — this block states coverage plainly (this account
// measures ~0.02% Shopify session coverage per B7's notes; the number itself, not a hard-coded
// assumption, drives what renders here) and renders the account-level blended MER as a clearly
// separate figure, never inside a per-entity ROAS row.

import type { ShopifyBusinessEvidence } from "../api/types.ts";
import { formatPercent, formatRatio } from "../lib/format.ts";

export function AttributionBlock({ shopify }: { shopify: ShopifyBusinessEvidence }) {
  const coveragePercent =
    shopify.attributionCoverageRatio !== null ? shopify.attributionCoverageRatio * 100 : null;
  return (
    <div className="attribution-block">
      <h4>Attribution coverage</h4>
      <p className="attribution-block__note">{shopify.note}</p>
      <dl>
        <dt>Shopify orders resolved to a Meta ad (ID match only)</dt>
        <dd>{coveragePercent !== null ? formatPercent(coveragePercent, 2) : "not measured"}</dd>
        {shopify.attributionCoverageRatioIncludingNameMatch !== null && (
          <>
            <dt>Including lower-confidence name-matched orders</dt>
            <dd>{formatPercent(shopify.attributionCoverageRatioIncludingNameMatch * 100, 2)}</dd>
          </>
        )}
        <dt>Account-level blended MER (Meta spend vs. all Shopify revenue — not a per-ad ROAS)</dt>
        <dd>
          {shopify.blendedMerAccountOnly !== null
            ? `${formatRatio(shopify.blendedMerAccountOnly)}×`
            : "not measured"}
        </dd>
      </dl>
    </div>
  );
}
