// D6 — §24: "data freshness timestamp AND reporting timezone." Always shown; states honestly when
// provenance is unavailable (PENDING/GENERATING/FAILED never have one) rather than a fabricated
// "just now".

import type { RecommendationProvenance } from "../api/types.ts";
import { formatDateTime, formatRelativeFreshness } from "../lib/format.ts";

export function FreshnessBar({
  provenance,
  reportingTimezone,
}: {
  provenance: RecommendationProvenance | null;
  reportingTimezone: string;
}) {
  return (
    <div className="freshness-bar">
      <span className="freshness-bar__timezone">Reporting timezone: {reportingTimezone}</span>
      {provenance ? (
        <span className="freshness-bar__freshness" title={provenance.dataFreshThrough}>
          Data fresh through {formatDateTime(provenance.dataFreshThrough, reportingTimezone)} (
          {formatRelativeFreshness(provenance.dataFreshThrough)}) · model {provenance.model}
        </span>
      ) : (
        <span className="freshness-bar__freshness freshness-bar__freshness--pending">
          Data freshness not yet available
        </span>
      )}
    </div>
  );
}
