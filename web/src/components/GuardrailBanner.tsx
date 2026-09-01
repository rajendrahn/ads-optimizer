// D6 — a REJECTED recommendation renders as a first-class card, never an error/empty state.
// States which guardrail rejected it and what limit it was judged against (the coordinator's own
// framing) — one line per violation, each with its judged-against limit when there is one.

import type { GuardrailRejection } from "../api/types.ts";

const CODE_LABEL: Record<string, string> = {
  MAX_CHANGE_PERCENT_EXCEEDED: "Change too large",
  MIN_SPEND_NOT_MET: "Not enough spend",
  MIN_PURCHASES_NOT_MET: "Not enough purchases",
  DECISION_UNIT_NOT_BUDGET_OWNER: "Wrong decision unit",
  NO_DECISION_UNIT: "No decision unit",
  NOT_DELIVERING: "Not delivering",
};

export function GuardrailBanner({ rejection }: { rejection: GuardrailRejection }) {
  return (
    <div className="guardrail-banner" role="alert">
      <strong>Rejected by a guardrail.</strong> {rejection.reason}
      {rejection.violations.length > 0 && (
        <ul className="guardrail-banner__violations">
          {rejection.violations.map((v, i) => (
            <li key={i}>
              <strong>{CODE_LABEL[v.code] ?? v.code}</strong> — {v.message}
              {v.judgedAgainst && (
                <span className="guardrail-banner__judged-against">
                  {" "}
                  (judged against {v.judgedAgainst.field} = {v.judgedAgainst.limit}
                  {v.judgedAgainst.source === "default"
                    ? ", a placeholder default"
                    : ", an operator-configured limit"}
                  {v.judgedAgainst.actual !== null ? `; actual was ${v.judgedAgainst.actual}` : ""})
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="guardrail-banner__footnote">
        The model's own proposed reasoning is still shown below, for context — this rejection is
        itself a calibration signal, not a hidden failure.
      </p>
    </div>
  );
}
