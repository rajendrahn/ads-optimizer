// D6 — the ONE component in this app allowed to render a ROAS/CPA ratio figure. This is the
// structural half of "never show a ROAS without its sample size" (§24's display rule): `purchases`
// is a REQUIRED prop, typed `number` (never `number | undefined`) — a caller physically cannot
// compile a `<RoasMetric>` that renders a value without also supplying its sample size, and
// `source` is likewise required, so a caller cannot render a ratio without stating whether it is
// Meta- or Shopify-attributed (§6.2/§6.3: the two must never be merged or left unlabelled). No
// other component in this codebase formats a bare ROAS/CPA number — grep for `toFixed` /
// `formatRatio` outside this file to confirm.
//
// See RoasMetric.test.tsx for the two proofs: a TS-level one (constructing the props object
// without `purchases` is a compile error) and a runtime one (even if a caller smuggles a
// non-number `purchases` past the type system, this component refuses to print a bare number).

import type { MetricSnapshot } from "../api/types.ts";
import { formatMoney, formatRatio } from "../lib/format.ts";

export interface RoasMetricProps {
  label: string;
  metric: MetricSnapshot;
  /** Which attribution source this figure is on — always shown, always labelled, per §6.2/§6.3.
   * "money" renders `metric.value` as currency (CPA); "ratio" renders it as a bare multiple
   * (ROAS). */
  source: "meta" | "shopify";
  kind: "ratio" | "money";
  currency?: string;
}

export function RoasMetric({ label, metric, source, kind, currency }: RoasMetricProps) {
  const purchases = metric.purchases;
  const hasUsableSampleSize = typeof purchases === "number" && Number.isFinite(purchases);
  const sourceLabel = source === "meta" ? "Meta-attributed" : "Shopify-attributed";

  // Defense in depth, not just a type-level guarantee: even if bad data slips past the TS type
  // (e.g. JSON from a future API version), this component still refuses to print a bare number.
  if (metric.value === null || !hasUsableSampleSize) {
    return (
      <div className="roas-metric roas-metric--unavailable">
        <span className="roas-metric__label">
          {label} <em className="roas-metric__source">({sourceLabel})</em>
        </span>
        <span className="roas-metric__value roas-metric__value--muted">
          {metric.value === null ? "not measured" : "sample size unavailable"}
        </span>
      </div>
    );
  }

  const formattedValue =
    kind === "money"
      ? formatMoney(metric.value, currency ?? "INR")
      : `${formatRatio(metric.value)}×`;
  const [low, high] = metric.interval;

  return (
    <div className="roas-metric" data-verdict={metric.verdict ?? undefined}>
      <span className="roas-metric__label">
        {label} <em className="roas-metric__source">({sourceLabel})</em>
      </span>
      <span className="roas-metric__value">{formattedValue}</span>
      <span className="roas-metric__purchases">
        on {purchases} purchase{purchases === 1 ? "" : "s"}
      </span>
      {low !== null && high !== null && (
        <span className="roas-metric__interval">
          interval {kind === "money" ? formatMoney(low, currency ?? "INR") : `${formatRatio(low)}×`}
          –{kind === "money" ? formatMoney(high, currency ?? "INR") : `${formatRatio(high)}×`}
        </span>
      )}
      {metric.verdict && (
        <span className="roas-metric__verdict">{metric.verdict.replaceAll("_", " ")}</span>
      )}
      <span className="roas-metric__reason">{metric.verdictReason}</span>
    </div>
  );
}
