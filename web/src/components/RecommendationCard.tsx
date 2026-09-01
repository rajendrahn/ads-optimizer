// D6 — the recommendation card, §24. Dispatches on `status` first, then on `packet.outcome` —
// every branch renders as a first-class card: PENDING/GENERATING show progress, FAILED shows the
// real error, REJECTED shows which guardrail and why, and all three D1 outcomes
// (EVIDENCE/NOT_DELIVERING/NO_DECISION_UNIT) render as legitimate answers, never as errors or
// empty states.

import { useState } from "react";
import type { RecommendationView } from "../api/types.ts";
import { acceptRecommendation, rejectRecommendation } from "../api/client.ts";
import { EscalationBanner } from "./EscalationBanner.tsx";
import { AttributionBlock } from "./AttributionBlock.tsx";
import { GuardrailBanner } from "./GuardrailBanner.tsx";
import { FreshnessBar } from "./FreshnessBar.tsx";
import { WindowEvidenceBlock } from "./WindowEvidenceBlock.tsx";
import { formatMoney, formatPercent } from "../lib/format.ts";

function ProgressCard({ view }: { view: RecommendationView }) {
  return (
    <div className="rec-card rec-card--progress" data-status={view.status}>
      <p className="rec-card__question">{view.requestedQuestion}</p>
      <p className="rec-card__status">
        {view.status === "PENDING" ? "Queued…" : "Reasoning…"}
        <span className="rec-card__spinner" aria-hidden="true" />
      </p>
    </div>
  );
}

function FailedCard({ view }: { view: RecommendationView }) {
  return (
    <div className="rec-card rec-card--failed" data-status="FAILED">
      <p className="rec-card__question">{view.requestedQuestion}</p>
      <p className="rec-card__error" role="alert">
        Something went wrong generating this recommendation: {view.errorMessage}
      </p>
    </div>
  );
}

function NotDeliveringCard({ view }: { view: RecommendationView }) {
  const packet = view.packet;
  if (!packet || packet.outcome !== "NOT_DELIVERING") return null;
  return (
    <div className="rec-card rec-card--not-delivering" data-status={view.status}>
      <p className="rec-card__question">{view.requestedQuestion}</p>
      {packet.escalatedFrom && (
        <EscalationBanner escalatedFrom={packet.escalatedFrom} decisionUnit={packet.decisionUnit} />
      )}
      <p className="rec-card__answer">
        <strong>Not delivering.</strong>{" "}
        {packet.evidence.decisionUnitName ?? packet.evidence.decisionUnit.id} has zero spend and
        zero impressions in the {packet.evidence.primaryWindow} window — there is no evidence to
        support a budget decision either way.
      </p>
      <p className="rec-card__detail">{packet.evidence.detail}</p>
      <FreshnessBar provenance={view.provenance} reportingTimezone={view.reportingTimezone} />
    </div>
  );
}

function NoDecisionUnitCard({ view }: { view: RecommendationView }) {
  const packet = view.packet;
  if (!packet || packet.outcome !== "NO_DECISION_UNIT") return null;
  return (
    <div className="rec-card rec-card--no-decision-unit" data-status={view.status}>
      <p className="rec-card__question">{view.requestedQuestion}</p>
      <p className="rec-card__answer">
        <strong>No identifiable decision unit.</strong> Budget ownership for this entity could not
        be resolved unambiguously.
      </p>
      <p className="rec-card__detail">{packet.evidence.detail}</p>
      <FreshnessBar provenance={view.provenance} reportingTimezone={view.reportingTimezone} />
    </div>
  );
}

function EvidenceCard({ view, onDecided }: { view: RecommendationView; onDecided: () => void }) {
  const packet = view.packet;
  const [pending, setPending] = useState<"accept" | "reject" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canDecide =
    view.status === "COMPLETE" &&
    view.action !== "INSUFFICIENT_DATA" &&
    !view.acceptedAt &&
    !view.rejectedByUserAt;

  async function handle(action: "accept" | "reject") {
    setPending(action);
    setActionError(null);
    try {
      if (action === "accept") await acceptRecommendation(view.recommendationId);
      else await rejectRecommendation(view.recommendationId);
      onDecided();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      className="rec-card rec-card--evidence"
      data-status={view.status}
      data-action={view.action ?? undefined}
    >
      <p className="rec-card__question">{view.requestedQuestion}</p>

      {packet?.outcome === "EVIDENCE" && packet.escalatedFrom && (
        <EscalationBanner escalatedFrom={packet.escalatedFrom} decisionUnit={packet.decisionUnit} />
      )}

      {view.status === "REJECTED" && view.guardrailRejection && (
        <GuardrailBanner rejection={view.guardrailRejection} />
      )}

      <div className="rec-card__headline">
        <span className="rec-card__action">{view.action?.replaceAll("_", " ") ?? "—"}</span>
        {view.decisionUnit && (
          <span className="rec-card__decision-unit">
            {view.decisionUnit.type.toLowerCase()} <code>{view.decisionUnit.id}</code>
          </span>
        )}
        {view.confidence !== null && (
          <span className="rec-card__confidence">
            confidence {formatPercent(view.confidence * 100, 0)}
          </span>
        )}
      </div>

      {view.currentBudgetMinorUnits !== null && view.recommendedBudgetMinorUnits !== null && (
        <div className="rec-card__budget">
          <span>current: {formatMoney(view.currentBudgetMinorUnits, view.currency)}/day</span>
          <span>→</span>
          <span>
            recommended: {formatMoney(view.recommendedBudgetMinorUnits, view.currency)}/day
          </span>
          {view.changePercent !== null && (
            <span>
              ({view.changePercent > 0 ? "+" : ""}
              {view.changePercent}%)
            </span>
          )}
        </div>
      )}

      {view.summary && <p className="rec-card__summary">{view.summary}</p>}

      {view.primaryReasons && view.primaryReasons.length > 0 && (
        <div className="rec-card__reasons">
          <h4>Why</h4>
          <ul>
            {view.primaryReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {view.risks && view.risks.length > 0 && (
        <div className="rec-card__risks">
          <h4>Risks</h4>
          <ul>
            {view.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {packet?.outcome === "EVIDENCE" && (
        <details className="rec-card__evidence-details">
          <summary>Evidence</summary>
          <AttributionBlock shopify={packet.evidence.evidence.shopify} />
          {Object.entries(packet.evidence.evidence.windows).map(([label, w]) =>
            w ? <WindowEvidenceBlock key={label} window={w} currency={view.currency} /> : null,
          )}
          <p className="rec-card__targets">
            Judged against target ROAS {packet.evidence.targets.targetRoas} / target CPA{" "}
            {formatMoney(packet.evidence.targets.targetCpaMinorUnits, view.currency)} —{" "}
            {packet.evidence.targets.source === "default"
              ? "PLACEHOLDER defaults, not yet configured by an operator: treat with appropriate skepticism."
              : "the operator's own configured targets."}
          </p>
        </details>
      )}

      {packet?.textRendering && (
        <details className="rec-card__prose">
          <summary>Full evidence text</summary>
          <pre>{packet.textRendering}</pre>
        </details>
      )}

      <FreshnessBar provenance={view.provenance} reportingTimezone={view.reportingTimezone} />

      {view.acceptedAt && (
        <p className="rec-card__decision rec-card__decision--accepted">Accepted.</p>
      )}
      {view.rejectedByUserAt && (
        <p className="rec-card__decision rec-card__decision--rejected">Rejected.</p>
      )}
      {actionError && (
        <p className="rec-card__action-error" role="alert">
          {actionError}
        </p>
      )}
      {canDecide && (
        <div className="rec-card__actions">
          <button type="button" disabled={pending !== null} onClick={() => void handle("accept")}>
            {pending === "accept" ? "Accepting…" : "Accept"}
          </button>
          <button type="button" disabled={pending !== null} onClick={() => void handle("reject")}>
            {pending === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      )}
    </div>
  );
}

export function RecommendationCard({
  view,
  onDecided,
}: {
  view: RecommendationView;
  onDecided: () => void;
}) {
  if (view.status === "PENDING" || view.status === "GENERATING")
    return <ProgressCard view={view} />;
  if (view.status === "FAILED") return <FailedCard view={view} />;
  if (view.packet?.outcome === "NOT_DELIVERING") return <NotDeliveringCard view={view} />;
  if (view.packet?.outcome === "NO_DECISION_UNIT") return <NoDecisionUnitCard view={view} />;
  return <EvidenceCard view={view} onDecided={onDecided} />;
}
