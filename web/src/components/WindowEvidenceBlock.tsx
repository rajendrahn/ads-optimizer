// D6 — one window's worth of evidence (§14/§24: "supporting evidence with sample sizes and
// intervals"). Meta- and Shopify-attributed ROAS render as two SEPARATE `<RoasMetric>` calls —
// structurally impossible to merge into one figure without editing this file, per §6.2/§6.3.

import type { WindowEvidence } from "../api/types.ts";
import { RoasMetric } from "./RoasMetric.tsx";
import { formatPercent } from "../lib/format.ts";

export function WindowEvidenceBlock({
  window,
  currency,
}: {
  window: WindowEvidence;
  currency: string;
}) {
  return (
    <div className="window-block">
      <h4 className="window-block__title">{window.window} window</h4>
      <RoasMetric label="ROAS" metric={window.metaRoas} source="meta" kind="ratio" />
      {window.metaRoasShrunk !== null && (
        <p className="window-block__shrunk">
          shrunk toward the account mean: {window.metaRoasShrunk.toFixed(2)}× — compare post-change
          performance against this, never the raw figure
        </p>
      )}
      <RoasMetric
        label="CPA"
        metric={window.cpaMinorUnits}
        source="meta"
        kind="money"
        currency={currency}
      />
      <RoasMetric label="ROAS" metric={window.shopifyRoas} source="shopify" kind="ratio" />
      {window.shopifyDataGap?.windowHasDataGap && (
        <p className="window-block__gap-warning">
          Shopify data gap inside this window ({window.shopifyDataGap.gapDays.length} day
          {window.shopifyDataGap.gapDays.length === 1 ? "" : "s"} missing) — the Shopify-attributed
          figures above are structurally low for this window, not a real signal.
        </p>
      )}
      <dl className="window-block__meta">
        <dt>Spend</dt>
        <dd>{(window.spendMinorUnits / 100).toFixed(2)}</dd>
        <dt>CTR</dt>
        <dd>{window.ctr !== null ? formatPercent(window.ctr * 100, 2) : "—"}</dd>
        <dt>CVR</dt>
        <dd>{window.cvr !== null ? formatPercent(window.cvr * 100, 2) : "—"}</dd>
        <dt>Frequency</dt>
        <dd>{window.frequency !== null ? window.frequency.toFixed(2) : "—"}</dd>
      </dl>
      {window.seasonality.labels.length > 0 && (
        <p className="window-block__seasonality">{window.seasonality.summaryText}</p>
      )}
    </div>
  );
}
