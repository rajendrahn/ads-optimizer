// D5 — guardrailRejections/{recommendationId}. §20.2: "A rejected recommendation is logged with
// its rejection reason — that log is itself a calibration signal [for E3]." Kept as its own,
// durable, queryable collection — NOT folded only into `recommendations/{id}.guardrailRejection`
// (D2's own single `{reason, rejectedAt}` pair on the recommendation document itself, which this
// still also populates) — because E3 needs to query rejections in aggregate (by violation code,
// by which limit was judged against, by whether the limit came from settings or a default) without
// scanning every `recommendations` document, and because this log is the one place D5 records the
// EXACT numbers a rejection was judged against, frozen at rejection time — so correcting a
// guardrail threshold later changes future outcomes without rewriting what a past rejection says
// it was judged against.

import { z } from "zod";
import { entityRef, firestoreTimestamp } from "./common.ts";
import { recommendationTypeSchema } from "./decisions.ts";

/**
 * Every independent reason a guardrail can reject a recommendation. Not priority-ordered — a
 * single rejection can (and often will) carry more than one violation, each independently true,
 * matching this codebase's own established "report every failing gate, not just the first one"
 * convention (D1's `IneligibilityReason[]`).
 */
export const guardrailViolationCodeSchema = z.enum([
  /** §20.2: "budget change above the configured maximum percentage." */
  "MAX_CHANGE_PERCENT_EXCEEDED",
  /** §20.2: "minimum spend ... requirements not met." */
  "MIN_SPEND_NOT_MET",
  /** §20.2: "... and purchase requirements not met." */
  "MIN_PURCHASES_NOT_MET",
  /** §20.2: "decision unit is not the actual budget owner" — the model named a real, resolved
   * decision unit that disagrees with D1's own independent resolution. */
  "DECISION_UNIT_NOT_BUDGET_OWNER",
  /** The model named a decision unit at all when D1's independent resolution found none —
   * budget ownership is genuinely `NO_DECISION_UNIT` for this entity. */
  "NO_DECISION_UNIT",
  /** The resolved decision unit has zero spend and zero impressions in the primary window (D1's
   * own `NOT_DELIVERING` outcome) — there is no evidence to support any action other than
   * `INSUFFICIENT_DATA`. */
  "NOT_DELIVERING",
]);
export type GuardrailViolationCode = z.infer<typeof guardrailViolationCodeSchema>;

/** What a violation was judged against — always present for the three numeric-limit codes above
 * (MAX_CHANGE_PERCENT_EXCEEDED, MIN_SPEND_NOT_MET, MIN_PURCHASES_NOT_MET), `null` for the two
 * structural codes (there is no single number a decision-unit/delivery mismatch is "judged
 * against"). This is what makes a target correction affect future outcomes rather than the
 * historical record of what this rejection was judged against at the time. */
export const guardrailJudgedAgainstSchema = z.object({
  /** Dotted path into the resolved thresholds this was read from, e.g.
   * "guardrailThresholds.maxChangePercent" or "statisticalThresholds.minPurchaseFloors.28d". */
  field: z.string().min(1),
  limit: z.number(),
  /** Whether the limit came from an operator-supplied `settings/{accountId}` document or this
   * system's built-in placeholder default (reality #6, D1's notes) — a rejection judged against a
   * default should be read with different confidence than one judged against a real operator
   * setting. */
  source: z.enum(["settings", "default"]),
  actual: z.number().nullable(),
});
export type GuardrailJudgedAgainst = z.infer<typeof guardrailJudgedAgainstSchema>;

export const guardrailViolationSchema = z.object({
  code: guardrailViolationCodeSchema,
  message: z.string().min(1),
  judgedAgainst: guardrailJudgedAgainstSchema.nullable(),
});
export type GuardrailViolation = z.infer<typeof guardrailViolationSchema>;

export const guardrailRejectionLogSchema = z.object({
  recommendationId: z.string().min(1),
  namedEntity: entityRef.nullable(),
  /** What the model itself claimed as the decision unit — `null` when the model didn't name one
   * (e.g. it already answered `INSUFFICIENT_DATA`, which cannot itself be a rejection reason). */
  decisionUnitClaimedByModel: entityRef.nullable(),
  /** D1's own independently-resolved decision unit — computed BEFORE the model ever ran, from
   * this account's actual Meta budget-ownership configuration, never from anything the model or
   * the knowledge document said. `null` when D1 found no decision unit at all. */
  decisionUnitResolved: entityRef.nullable(),
  recommendationType: recommendationTypeSchema.nullable(),
  changePercent: z.number().nullable(),
  violations: z.array(guardrailViolationSchema).min(1),
  /** Joined, human-readable summary of every violation — mirrors
   * `recommendations/{id}.guardrailRejection.reason` exactly (same string), so the two never
   * disagree about why a given recommendation was rejected. */
  reason: z.string().min(1),
  accountDataVersion: z.number().int().nonnegative().nullable(),
  /** Recorded for audit/calibration ONLY — see services/reasoner/guardrails.ts's own module
   * comment for the structural guarantee this reflects: `validateGuardrails` itself never reads
   * this field or anything it names. Stamped here strictly AFTER the guardrail decision is
   * already final, purely so E3 can later ask "did rejections correlate with a particular
   * knowledge version" without that question ever having been able to influence the decision. */
  adOptimizationKnowledgeVersion: z.string().nullable(),
  rejectedAt: firestoreTimestamp,
});
export type GuardrailRejectionLog = z.infer<typeof guardrailRejectionLogSchema>;
