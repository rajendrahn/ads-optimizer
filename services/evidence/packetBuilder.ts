// D2's packet builder proper: turns D1's `ScalingEvidenceResult` (one of EVIDENCE/
// NOT_DELIVERING/NO_DECISION_UNIT — see types.ts) into the structured `DecisionPacket` Firestore
// shape AND its text rendering (packetText.ts), in one pure function. Pure — no Firestore here,
// so this is fully unit-testable without an emulator; `decisionPacketStore.ts` is the thin
// Firestore glue that reads the current `accountDataVersion`, calls this, and writes the result
// through `upsertWithVersionGuard`.
//
// "currentAccountDataVersion" is deliberately an explicit input, not read off
// `evidence.accountDataVersion` — a packet's own cache-staleness bookkeeping is stamped against
// the ONE account-wide monotonic counter §10.1 describes ("bumped once per sync run... mark all
// decision packets stale"), which exists independent of whether this particular call resolved to
// EVIDENCE (which happens to carry a per-entity-feature-doc copy of the same number),
// NOT_DELIVERING, or NO_DECISION_UNIT (neither of which read any entity-feature doc at all, so
// there is no `evidence.accountDataVersion` to borrow). Stamping all three outcomes against the
// same externally-supplied "current version" keeps staleness detection uniform across the union.

import type { ScalableEntityRef, ScalingEvidenceResult } from "./types.ts";
import type { DecisionPacket } from "@shared/schema/index.ts";
import { decisionPacketKey } from "@shared/firestore/index.ts";
import { renderDecisionPacketText } from "./packetText.ts";

export interface BuildDecisionPacketInput {
  /** What was actually asked about — D1's `ScalingEvidenceResult` only carries this for the
   * NOT_DELIVERING/NO_DECISION_UNIT branches (`result.namedEntity`); the EVIDENCE branch doesn't
   * repeat it, so the caller (who supplied it to `resolveScalingEvidence` in the first place)
   * passes it through explicitly here, uniformly across all three outcomes. */
  namedEntity: ScalableEntityRef;
  result: ScalingEvidenceResult;
  /** The account's current monotonic `accountDataVersion` (§10.1) — see module comment. */
  currentAccountDataVersion: number;
  now: Date;
}

function evidenceRecordFor(result: ScalingEvidenceResult): Record<string, unknown> {
  switch (result.outcome) {
    case "EVIDENCE":
      // Already a plain object with every Date pre-converted to an ISO string
      // (evidenceAssembler.ts) — but `ScalingEvidence.escalatedFrom` is an OPTIONAL TS field
      // (`undefined` when there was no escalation), and Firestore rejects `undefined` anywhere
      // in a document outright ("Cannot use 'undefined' as a Firestore value"). A JSON round-trip
      // is the simplest correct sanitizer here — it drops every `undefined`-valued key (there is
      // no other non-JSON-safe value left in this object) without this module having to hand-walk
      // D1's own object shape to find the one optional field.
      return JSON.parse(JSON.stringify(result.evidence)) as Record<string, unknown>;
    case "NOT_DELIVERING":
      return {
        namedEntity: result.namedEntity,
        decisionUnit: result.decisionUnit,
        decisionUnitName: result.decisionUnitName,
        escalatedFrom: result.escalatedFrom ?? null,
        primaryWindow: result.primaryWindow,
        detail: result.detail,
      };
    case "NO_DECISION_UNIT":
      return { namedEntity: result.namedEntity, detail: result.detail };
  }
}

/**
 * Pure: `ScalingEvidenceResult` + the current account version -> a full `DecisionPacket`
 * (structured object AND text rendering, both required deliverables per this step's brief).
 * `isStale` is always `false` on a freshly-built packet by construction — it was just built
 * against `currentAccountDataVersion`, the definition of "not stale" (`decisionPacketStore.ts`'s
 * `markStalePackets` is what flips it later, once a NEWER version has since been bumped).
 */
export function buildDecisionPacket(input: BuildDecisionPacketInput): DecisionPacket {
  const { result, namedEntity, currentAccountDataVersion, now } = input;

  const decisionUnit =
    result.outcome === "EVIDENCE"
      ? result.evidence.decisionUnit
      : result.outcome === "NOT_DELIVERING"
        ? result.decisionUnit
        : null; // NO_DECISION_UNIT — reality #3, there genuinely is none (§4.1).

  const escalatedFrom =
    result.outcome === "EVIDENCE"
      ? (result.evidence.escalatedFrom ?? null)
      : result.outcome === "NOT_DELIVERING"
        ? (result.escalatedFrom ?? null)
        : null;

  return {
    packetId: decisionPacketKey(namedEntity.type, namedEntity.id),
    outcome: result.outcome,
    namedEntity,
    decisionUnit,
    escalatedFrom,
    accountDataVersion: currentAccountDataVersion,
    isStale: false,
    evidence: evidenceRecordFor(result),
    textRendering: renderDecisionPacketText(result, currentAccountDataVersion),
    createdAt: now,
  };
}
