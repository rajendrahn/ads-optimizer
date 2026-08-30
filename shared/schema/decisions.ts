// Decision collections — §8: decisionPackets, recommendations, recommendationOutcomes.
//
// Populated by D1/D2 (packets), D3/D4 (recommendations), E2 (outcomes). A2 fixes the shape
// only — see the module comment in features.ts for the same "typed now, semantics later"
// framing, which applies equally here.

import { z } from "zod";
import { entityRef, firestoreTimestamp } from "./common.ts";

// ---------------------------------------------------------------------------------------
// decisionPackets — §10.1, §14, §24 (D2)
// ---------------------------------------------------------------------------------------

export const decisionPacketSchema = z.object({
  packetId: z.string().min(1),
  decisionUnit: entityRef,
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

export const recommendationSchema = z.object({
  recommendationId: z.string().min(1),
  status: recommendationStatusSchema,
  packetId: z.string().nullable(),
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
  createdAt: firestoreTimestamp,
  updatedAt: firestoreTimestamp,
  acceptedAt: firestoreTimestamp.nullable(), // user's accept — §24
  rejectedByUserAt: firestoreTimestamp.nullable(), // user's reject — distinct from guardrailRejection
});
export type Recommendation = z.infer<typeof recommendationSchema>;

// ---------------------------------------------------------------------------------------
// recommendationOutcomes/{recommendationId} — §21.1
// ---------------------------------------------------------------------------------------

export const recommendationOutcomeSchema = z.object({
  recommendationId: z.string().min(1),
  evaluatedAt: firestoreTimestamp.nullable(),
  triggeredBy: z.literal("RECHECK_CONDITIONS_MET").nullable(), // §21.1 — never a fixed number of days
  additionalSpendMinorUnits: z.number().int().nullable(),
  additionalPurchases: z.number().int().nullable(),
  roasAfter: z.number().nullable(),
  baselineShrunk: z.number().nullable(), // §21.1/§15.3 — compared against the shrunk baseline, never raw
  classification: z.enum(["SUCCESS", "NEUTRAL", "FAILURE"]).nullable(), // exact taxonomy is E2's call
  createdAt: firestoreTimestamp,
});
export type RecommendationOutcome = z.infer<typeof recommendationOutcomeSchema>;
