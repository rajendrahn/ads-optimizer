// D6 — §4.1/§24: "decision unit, with escalation stated when it occurred." Rendered prominently,
// before any metric — states what was escalated FROM, what it escalated TO, and why, in one place.

import type { EntityRef, EscalatedFrom } from "../api/types.ts";

const REASON_PROSE: Record<string, string> = {
  SAMPLE_TOO_SMALL: "its own volume was below the statistical floor for a reliable verdict",
  AD_NOT_BUDGET_OWNER: "an ad never owns a budget of its own in this account's Meta configuration",
  ADSET_NOT_BUDGET_OWNER:
    "this ad set defers to its campaign's budget (campaign budget optimization)",
  CAMPAIGN_NOT_BUDGET_OWNER: "this campaign defers to one of its ad sets' own budget",
};

export function EscalationBanner({
  escalatedFrom,
  decisionUnit,
}: {
  escalatedFrom: EscalatedFrom;
  decisionUnit: EntityRef | null;
}) {
  const reason = REASON_PROSE[escalatedFrom.reason] ?? escalatedFrom.reason;
  return (
    <div className="escalation-banner" role="note">
      <strong>Escalated.</strong> You asked about {escalatedFrom.type.toLowerCase()}{" "}
      <code>{escalatedFrom.id}</code>; the answer below is about{" "}
      {decisionUnit ? (
        <>
          {decisionUnit.type.toLowerCase()} <code>{decisionUnit.id}</code>
        </>
      ) : (
        "a different decision unit"
      )}{" "}
      instead, because {reason}.
    </div>
  );
}
