// D5 — adapter conforming to D4's own `GuardrailValidator` type
// (services/reasoner/job/guardrailSeam.ts, read but never edited by this step — that directory is
// D4's job pipeline, out of D5's scope). That module's own comment instructs: "Whoever implements
// D5's real validator should write a function matching this exact type... doing so keeps the
// guarantee structural rather than behavioural." This file is that function.
//
// D4's `GuardrailValidator` is deliberately narrow — `(recommendation: RecommendationOutput) =>
// GuardrailVerdict | Promise<GuardrailVerdict>` — with no parameter for evidence, canon, or a
// Firestore handle. To honour that exact signature while still checking against independently-
// computed evidence (this step's own core requirement), `createGuardrailValidator` below closes
// over `db`/`canon` and, for every call, RE-RESOLVES the named entity's evidence itself via D1's
// `resolveScalingEvidence` — the same function D2's packet builder calls, but invoked fresh here,
// independent of whatever the packet the model actually reasoned over contained. This is not
// merely tolerated by the narrow seam, it is arguably the stronger property: the guardrail never
// trusts a packet, a cached evidence object, or anything upstream of this call — it re-derives
// today's ground truth from this account's own Meta/Shopify-sourced Firestore data every time.
//
// **A real, honestly-stated limitation of integrating through THIS narrow seam specifically**
// (not of `validateGuardrails`/`applyGuardrails` themselves, which do not have it): the seam does
// not pass `recommendationId`, the originally-`namedEntity`, or D3.1's own knowledge version, so
// the rejection log entry this adapter writes cannot key on the real `recommendationId`
// `generateRecommendationTask.ts` already has in scope one call frame up — it synthesizes an id
// instead (see below). **The higher-fidelity integration** — real `recommendationId`, the
// packet's own `namedEntity`/`accountDataVersion` (no re-fetch), and the knowledge version from
// `reasonerResult.provenance` — is `applyGuardrails` (guardrailLog.ts), called directly from
// inside `generateRecommendationTask.ts`'s own try block (which already has every one of those
// values in scope) in place of the narrow `guardrailValidator(...)` call. See this step's own
// "Notes for D4" in IMPLEMENTATION_PLAN.md for exactly where. Both integrations share the same
// decision core (`validateGuardrails`) and the same log collection
// (`guardrailRejections/{id}`) — this adapter exists so the CURRENT seam works with a one-line
// swap even before that richer wiring lands.

import type { Firestore } from "firebase-admin/firestore";
import { getDb } from "@shared/firestore/index.ts";
import { loadReportingCanon, type CanonSettings } from "@shared/canon/index.ts";
import { resolveScalingEvidence } from "@services/evidence/index.ts";
import type { GuardrailValidator, GuardrailVerdict } from "./job/guardrailSeam.ts";
import { validateGuardrails } from "./guardrails.ts";
import { logGuardrailRejection } from "./guardrailLog.ts";

export interface CreateGuardrailValidatorDeps {
  db?: Firestore;
  /** Supply a pre-loaded canon to avoid one extra Firestore read per call (e.g. the caller
   * already loaded it for the same request); otherwise loaded fresh, per call, via
   * `loadReportingCanon`. */
  canon?: CanonSettings;
  now?: () => Date;
}

/**
 * Builds a `GuardrailValidator` (D4's exact type) backed by this step's real §20.2 logic. Drop-in
 * replacement for `passthroughGuardrailValidator` at
 * `createGenerateRecommendationHandler({ guardrailValidator: createGuardrailValidator() })`.
 */
export function createGuardrailValidator(
  deps: CreateGuardrailValidatorDeps = {},
): GuardrailValidator {
  return async (recommendation): Promise<GuardrailVerdict> => {
    const db = deps.db ?? getDb();
    const now = deps.now ?? (() => new Date());

    // An honest "no decision unit" claim (INSUFFICIENT_DATA, or any type the model correctly
    // declined to attach a budget owner to) needs no evidence lookup at all — same treatment as
    // validateGuardrails' own `checkDecisionUnit`.
    if (recommendation.decisionUnit === null) {
      return { verdict: "ACCEPTED" };
    }

    const canon = deps.canon ?? (await loadReportingCanon({ db }));
    const evidenceResult = await resolveScalingEvidence({
      db,
      namedEntity: recommendation.decisionUnit,
    });

    const decision = validateGuardrails({ recommendation, evidenceResult, canon });
    if (decision.outcome === "APPROVED") {
      return { verdict: "ACCEPTED" };
    }

    const decisionUnitResolved =
      evidenceResult.outcome === "EVIDENCE"
        ? evidenceResult.evidence.decisionUnit
        : evidenceResult.outcome === "NOT_DELIVERING"
          ? evidenceResult.decisionUnit
          : null;

    // §20.2's own "logged with its reason" — even through this narrow seam, every rejection is
    // still durably logged. `recommendationId` is synthesized (the real one is not in scope at
    // this call site — see module comment) but still unique-per-attempt and still traceable to
    // exactly which claimed entity and instant it concerns.
    await logGuardrailRejection({
      db,
      recommendationId: `adapter_${recommendation.decisionUnit.type}_${recommendation.decisionUnit.id}_${now().getTime()}`,
      namedEntity: null, // not available at this call site — see module comment
      decisionUnitClaimedByModel: recommendation.decisionUnit,
      decisionUnitResolved,
      recommendationType: recommendation.recommendation,
      changePercent: recommendation.changePercent,
      decision,
      accountDataVersion:
        evidenceResult.outcome === "EVIDENCE" ? evidenceResult.evidence.accountDataVersion : null,
      adOptimizationKnowledgeVersion: null, // not available at this call site — see module comment
      now: now(),
    });

    return { verdict: "REJECTED", reason: decision.reason };
  };
}
