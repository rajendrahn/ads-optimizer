// Decision collections — §8: decisionPackets, recommendations, recommendationOutcomes.
//
// Populated by D1/D2 (packets), D3/D4 (recommendations), E2 (outcomes). A2 fixes the shape
// only — see the module comment in features.ts for the same "typed now, semantics later"
// framing, which applies equally here.

import { z } from "zod";
import { entityRef, firestoreTimestamp, reportingDay } from "./common.ts";
import { windowLabel } from "./features.ts";

// ---------------------------------------------------------------------------------------
// decisionPackets — §10.1, §14, §24 (D2)
// ---------------------------------------------------------------------------------------

// D2's own extension of A2's scaffold — three new/loosened fields, all optional/defaulted so
// A2's original schema.test.ts fixture (no `outcome`/`namedEntity`, always a non-null
// `decisionUnit`) still parses unchanged:
//   - `outcome` — D1's ScalingEvidenceResult is a discriminated union on exactly this
//     ("EVIDENCE" | "NOT_DELIVERING" | "NO_DECISION_UNIT"); the packet keeps that discriminant
//     rather than flattening all three into one always-populated shape with nulled-out fields.
//     Defaulted to "EVIDENCE" — every packet written before this field existed was one.
//   - `namedEntity` — what was actually asked about, distinct from `decisionUnit` (what the
//     evidence is actually FOR, which can differ after escalation, or not exist at all for
//     NO_DECISION_UNIT). Always populated by D2's own builder; nullable/defaulted only so an
//     older/hand-built doc without it still parses.
//   - `decisionUnit` loosened to nullable — reality #3 (§4.1): budget ownership can genuinely be
//     UNKNOWN, in which case there IS no decision unit to name. D2 writes `null` there and relies
//     on `namedEntity` to say what was asked about, rather than fabricating a decision unit that
//     was never resolved.
export const decisionPacketOutcomeSchema = z.enum([
  "EVIDENCE",
  "NOT_DELIVERING",
  "NO_DECISION_UNIT",
]);
export type DecisionPacketOutcome = z.infer<typeof decisionPacketOutcomeSchema>;

export const decisionPacketSchema = z.object({
  packetId: z.string().min(1),
  outcome: decisionPacketOutcomeSchema.default("EVIDENCE"),
  namedEntity: entityRef.nullable().default(null),
  decisionUnit: entityRef.nullable(),
  escalatedFrom: z
    .object({
      type: z.enum(["AD", "ADSET", "CAMPAIGN"]),
      id: z.string().min(1),
      reason: z.string(),
    })
    .nullable(), // §4.1
  accountDataVersion: z.number().int().nonnegative(),
  isStale: z.boolean(), // §10.1 — flipped true once accountDataVersion advances past this
  evidence: z.record(z.string(), z.unknown()), // §14 shape; full typing is D1/D2's job
  // §15.2: intervals must appear in the text, not only the JSON, so the model reasons over
  // them rather than past them — D2's packet builder produces both.
  textRendering: z.string().nullable(),
  createdAt: firestoreTimestamp,
});
export type DecisionPacket = z.infer<typeof decisionPacketSchema>;

// ---------------------------------------------------------------------------------------
// recommendations/{id} — §16.1 (job pipeline), §20.1 (structured output), §20.2 (guardrails)
// ---------------------------------------------------------------------------------------

export const recommendationStatusSchema = z.enum([
  "PENDING",
  "GENERATING",
  "COMPLETE",
  "FAILED",
  "REJECTED", // guardrail-rejected — §20.2, downgraded rather than surfaced as-is
]);
export type RecommendationStatus = z.infer<typeof recommendationStatusSchema>;

export const recommendationTypeSchema = z.enum([
  "INCREASE_BUDGET",
  "REDUCE_BUDGET",
  "HOLD",
  "PAUSE",
  "RESTART",
  "LAUNCH_NEW_CREATIVE_TEST",
  "REFRESH_CREATIVE_FAMILY",
  "INVESTIGATE_LANDING_PAGE",
  "INVESTIGATE_PRODUCT_OR_PRICE",
  "INVESTIGATE_TRACKING",
  "CONSOLIDATE_ADSETS",
  "INSUFFICIENT_DATA",
]);
export type RecommendationType = z.infer<typeof recommendationTypeSchema>;

// D4's own extension — §19.4 provenance, stamped by D3's `buildProvenance` and persisted
// verbatim (field-for-field, no remapping — see D3's own "Notes for D4/D5") by the
// GENERATE_RECOMMENDATION worker. Not all of §19.4's fields had a home on `recommendationSchema`
// before this step (D3's own note: "D4 should extend it via `.extend(...)`, per this codebase's
// own established pattern"). Nullable/defaulted so A2/D3's own fixtures (no `provenance` key)
// still parse unchanged — a PENDING/GENERATING doc legitimately has none yet.
export const recommendationProvenanceSchema = z.object({
  model: z.string().min(1),
  provider: z.literal("anthropic"),
  promptVersion: z.string().min(1),
  decisionEngineVersion: z.string().min(1),
  featureVersion: z.number().int().nonnegative(),
  dataVersion: z.number().int().nonnegative(),
  generatedAt: z.string().min(1), // ISO instant
  dataFreshThrough: z.string().min(1), // ISO instant
  adOptimizationKnowledgeVersion: z.string().nullable(),
  stopReason: z.string().min(1),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheCreationInputTokens: z.number().int().nonnegative().nullable(),
    cacheReadInputTokens: z.number().int().nonnegative().nullable(),
  }),
});
export type RecommendationProvenance = z.infer<typeof recommendationProvenanceSchema>;

// D6's own additive extension — same pattern as A3/D2/D4's own `.extend`-shaped additions to
// this file (see the module-level comments above `recommendationProvenanceSchema`). D4's own
// `request.ts` (out of scope for D6 to modify) writes the PENDING doc without this field.
// Deliberately `.optional()`, NOT `.default(null)` — a defaulted field is REQUIRED in
// `z.infer`'s output type (zod guarantees a default fills every parse), which would make
// `Recommendation` require a `namedEntity` key and break `request.ts`'s existing object literal
// (a file D6 is not allowed to touch). `.optional()` keeps the key optional in both directions,
// so that literal keeps typechecking unmodified. D6's own create-recommendation route patches
// this field onto the doc immediately after `requestRecommendation` returns (a targeted
// `.update({namedEntity})`, not a full overwrite — see web/server/handlers.ts), sequenced before
// the local worker dispatch even begins (deps.ts), so there is no read-before-write race. Because
// it is now part of `recommendationSchema` itself, once written it survives every later PENDING ->
// GENERATING -> terminal read-modify-write cycle in generateRecommendationTask.ts (whose `current`
// is read through this same schema) rather than being silently dropped by the next transition
// write. What was actually asked about — distinct from `decisionUnit` below, which is what the
// answer ended up being ABOUT after D1's own escalation (§4.1), once one exists.
export const recommendationSchema = z.object({
  recommendationId: z.string().min(1),
  status: recommendationStatusSchema,
  packetId: z.string().nullable(),
  namedEntity: entityRef.nullable().optional(),
  decisionUnit: entityRef.nullable(),
  recommendation: recommendationTypeSchema.nullable(),
  currentBudgetMinorUnits: z.number().int().nullable(),
  recommendedBudgetMinorUnits: z.number().int().nullable(),
  changePercent: z.number().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  summary: z.string().nullable(),
  primaryReasons: z.array(z.string()).nullable(),
  risks: z.array(z.string()).nullable(),
  doNotDo: z.array(z.string()).nullable(),
  recheckConditions: z
    .object({
      minimumAdditionalSpendMinorUnits: z.number().int().nullable(),
      minimumAdditionalPurchases: z.number().int().nullable(),
    })
    .nullable(),
  // §20.2: a rejected recommendation is logged with its reason — itself a calibration signal.
  guardrailRejection: z.object({ reason: z.string(), rejectedAt: firestoreTimestamp }).nullable(),
  accountDataVersionAtGeneration: z.number().int().nonnegative().nullable(),
  requestedBy: z.string().nullable(),
  requestedQuestion: z.string().nullable(),
  errorMessage: z.string().nullable(), // §D4: failure states recorded, not swallowed
  provenance: recommendationProvenanceSchema.nullable().default(null), // D4's own addition — §19.4
  createdAt: firestoreTimestamp,
  updatedAt: firestoreTimestamp,
  acceptedAt: firestoreTimestamp.nullable(), // user's accept — §24
  rejectedByUserAt: firestoreTimestamp.nullable(), // user's reject — distinct from guardrailRejection
});
export type Recommendation = z.infer<typeof recommendationSchema>;

// ---------------------------------------------------------------------------------------
// recommendationOutcomes/{recommendationId} — §21.1 (E2)
// ---------------------------------------------------------------------------------------

// E2's own taxonomy — three states from A2's stub, plus one E2 adds. `SEASONALLY_CONFOUNDED` is
// forced whenever the evaluation window and the baseline it is judged against sit in different
// seasonal regimes (C5's own `spansSeasonalBoundary`) — the amended §21.1 requirement to "flag,
// do not silently score" such an outcome. A plain SUCCESS/FAILURE here would credit or blame the
// calendar rather than the decision; see services/evidence/outcomeEvaluation.ts's module comment
// for exactly when this fires and how `rawClassification` below preserves what the plain
// interval-vs-baseline comparison alone would have said.
export const recommendationOutcomeClassificationSchema = z.enum([
  "SUCCESS",
  "NEUTRAL",
  "FAILURE",
  "SEASONALLY_CONFOUNDED",
]);
export type RecommendationOutcomeClassification = z.infer<
  typeof recommendationOutcomeClassificationSchema
>;

const dayRangeSchema = z.object({ startDay: reportingDay, endDay: reportingDay });

export const recommendationOutcomeSchema = z.object({
  recommendationId: z.string().min(1),
  evaluatedAt: firestoreTimestamp.nullable(),
  triggeredBy: z.literal("RECHECK_CONDITIONS_MET").nullable(), // §21.1 — never a fixed number of days
  additionalSpendMinorUnits: z.number().int().nullable(),
  additionalPurchases: z.number().int().nullable(),
  roasAfter: z.number().nullable(),
  baselineShrunk: z.number().nullable(), // §21.1/§15.3 — compared against the shrunk baseline, never raw
  classification: recommendationOutcomeClassificationSchema.nullable(),
  createdAt: firestoreTimestamp,

  // ---- E2's own additive extension below — every field optional, so A2's own schema.test.ts
  // fixture (none of these keys present) still parses unchanged. See
  // services/evidence/outcomeEvaluation.ts for exactly how each one is computed. ----

  /** The exact reporting-day range the recheck-conditions evaluation actually ran over — starts
   * the day after `recommendations/{id}.acceptedAt`, ends the first day cumulative spend AND
   * purchases both clear `recheckConditions`. Recorded so the classification is auditable after
   * the fact, not just the number it produced. */
  evaluationWindow: dayRangeSchema.nullable().optional(),
  /** The decision unit's own primary window at the time the recommendation was GENERATED — the
   * same days `baselineShrunk` was actually computed over. Reconstructed from the decision
   * packet's own `createdAt`/`primaryWindow` (packets don't store an explicit day range) — see
   * outcomeEvaluation.ts for the exact reconstruction and its documented approximation. */
  baselineWindow: dayRangeSchema.nullable().optional(),
  /** Which §4.2 window label `baselineShrunk` was read from
   * (`decisionPacket.evidence.windows[primaryWindow].metaRoasShrunk` — D1's own `primaryWindow`,
   * almost always `"28d"`). */
  primaryWindow: windowLabel.nullable().optional(),
  /** Denormalized off `recommendations/{id}.decisionUnit` — lets E3 query outcomes without a
   * join back to the recommendation doc. */
  decisionUnit: entityRef.nullable().optional(),
  /** The Poisson-count interval (§15's own estimator, reused as-is — interval.ts) on `roasAfter`,
   * built from `additionalPurchases`. `classification` is computed by running THIS interval
   * through the SAME `computeVerdict` C3 uses for every other ROAS verdict in this system, with
   * `baselineShrunk` standing in for the usual fixed target: ABOVE_TARGET / BELOW_TARGET /
   * NOT_DISTINGUISHABLE map onto SUCCESS / FAILURE / NEUTRAL one-for-one. `null` when
   * `additionalPurchases` is 0 — no honest ratio-based interval from zero events, matching
   * interval.ts's own contract (this should not occur in practice, since a spend-only recheck
   * condition with zero purchases has no honest ROAS either — see outcomeEvaluation.ts). */
  roasAfterInterval: z
    .object({ intervalLow: z.number().nullable(), intervalHigh: z.number().nullable() })
    .nullable()
    .optional(),
  /** The z-score `roasAfterInterval` was built with, and whether it came from an operator's own
   * `settings/{accountId}.statisticalThresholds` or this system's built-in default — reality #6,
   * carried into the outcome record the same way `guardrailRejections.violations[].judgedAgainst`
   * does (D5), so a later correction to the z-score changes FUTURE outcomes' interval width
   * without rewriting what a past outcome's interval was actually judged with. */
  intervalZScore: z.number().nullable().optional(),
  intervalZScoreSource: z.enum(["settings", "default"]).nullable().optional(),
  /** `classification` BEFORE any seasonal override — what the plain interval-vs-baseline
   * comparison alone would have said. Equal to `classification` unless
   * `seasonalContext.spansSeasonalBoundary` is true, in which case `classification` is forced to
   * `SEASONALLY_CONFOUNDED` while this field preserves what would otherwise have been reported.
   * This divergence between the two fields IS the "flag, don't silently score" requirement — both
   * are always stored, never only the final answer. */
  rawClassification: z.enum(["SUCCESS", "NEUTRAL", "FAILURE"]).nullable().optional(),
  /** C5's own seasonal context (§21.1's amended requirement) for the evaluation window against
   * its baseline — carried in full, never suppressed, mirroring C2/C3's own "carry the number,
   * flag it, never suppress it" discipline. `spansSeasonalBoundary: true` is what forces
   * `classification` to `SEASONALLY_CONFOUNDED` above; `demandIndex` is honestly `null` at this
   * account's real history (C5's own n<2 policy) far more often than not — never treat a `null`
   * here as "no seasonal effect". */
  seasonalContext: z
    .object({
      evaluationWindowLabels: z.array(z.string()),
      baselineWindowLabels: z.array(z.string()),
      spansSeasonalBoundary: z.boolean(),
      demandIndex: z.number().nullable(),
      demandIndexSampleSize: z.number().int().nonnegative(),
      summaryText: z.string(),
    })
    .nullable()
    .optional(),
});
export type RecommendationOutcome = z.infer<typeof recommendationOutcomeSchema>;
