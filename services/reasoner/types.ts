// D3 — shared types for the Claude integration. See IMPLEMENTATION_PLAN.md D3's "Notes from
// implementation" for how these fit together; the short version:
//
//   packet (D2) --> prompt.ts assembles a request --> reasoner.ts runs the tool loop against
//   the live Claude API --> outputSchema.ts validates the final structured response -->
//   provenance.ts stamps how it was produced.
//
// D3 deliberately reuses D2's `DecisionPacket`/D1's `ScalingEvidence*` types rather than
// redefining equivalent shapes — see `@shared/schema/index.ts` and `services/evidence/index.ts`.

import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { CanonSettings } from "@shared/canon/index.ts";
import { recommendationTypeSchema } from "@shared/schema/index.ts";

/** Shared read-only context every tool handler and the prompt builder receive. Firestore access
 * is threaded through explicitly (never a module-level `getDb()`), matching every prior step's
 * dependency-injection convention (A2's repositories, D1's `resolveScalingEvidence`). */
export interface ReasonerContext {
  db: Firestore;
  canon: CanonSettings;
}

// ---------------------------------------------------------------------------------------
// §20.1 structured output. The design's own worked example uses `currentBudget`/
// `recommendedBudget` as bare numbers and `recheckConditions.minimumAdditionalSpend` — this
// schema instead uses `currentBudgetMinorUnits`/`recommendedBudgetMinorUnits`/
// `minimumAdditionalSpendMinorUnits`, matching `@shared/schema/decisions.ts`'s ALREADY-BUILT
// `recommendationSchema` (D2's own extension point) field-for-field. Two reasons, not a
// silent divergence:
//   1. §0.2's own standing convention: "Money: Integer minor units (paise), never floats" — a
//      bare `"currentBudget": 10000` is ambiguous between rupees and paise; the design's literal
//      JSON predates that convention being applied to this field.
//   2. D4 (out of scope here) writes this output straight into `recommendations/{id}`
//      (`recommendationSchema`). Matching field names field-for-field means D4 can assign this
//      object directly rather than remapping every key — see this step's own Notes for D4/D5.
// `recommendation`/`decisionUnit` reuse the exact zod enums/shape D1/D2 already established
// (`recommendationTypeSchema`, `ScalableEntityType`) rather than redefining equivalent ones.
// ---------------------------------------------------------------------------------------

export const recommendationDecisionUnitSchema = z.object({
  type: z.enum(["AD", "ADSET", "CAMPAIGN"]),
  id: z.string().min(1),
});

export const recommendationRecheckConditionsSchema = z.object({
  minimumAdditionalSpendMinorUnits: z.number().int().nonnegative().nullable(),
  minimumAdditionalPurchases: z.number().int().nonnegative().nullable(),
});

/** The model's own structured output — validated client-side (defense in depth: §19.3's
 * `output_config.format` already constrains the API response, this is the second check) and
 * INTENTIONALLY NOT the full `Recommendation` Firestore document — no `recommendationId`,
 * `status`, `guardrailRejection`, timestamps, etc. Those are D4/D5's to add; a model can propose
 * a recommendation, it cannot mint its own database identity or clear its own guardrail. */
export const recommendationOutputSchema = z.object({
  recommendation: recommendationTypeSchema,
  // `null` only for a genuinely no-decision-unit answer (mirrors D1/D2's own NO_DECISION_UNIT /
  // NOT_DELIVERING outcomes, which the model is expected to pass through honestly rather than
  // invent a unit for) — otherwise the entity this recommendation is actually about.
  decisionUnit: recommendationDecisionUnitSchema.nullable(),
  currentBudgetMinorUnits: z.number().int().nullable(),
  recommendedBudgetMinorUnits: z.number().int().nullable(),
  changePercent: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
  primaryReasons: z.array(z.string().min(1)).min(1),
  risks: z.array(z.string().min(1)),
  doNotDo: z.array(z.string().min(1)),
  recheckConditions: recommendationRecheckConditionsSchema.nullable(),
});
export type RecommendationOutput = z.infer<typeof recommendationOutputSchema>;

// ---------------------------------------------------------------------------------------
// §19.4 provenance — "model, provider, prompt version, decision-engine version, feature
// version, data version, generated timestamp, data-fresh-through timestamp." Plus D3.1's own
// addition: which ad-optimization knowledge version (if any) was in the prompt.
// ---------------------------------------------------------------------------------------

export interface ReasonerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export interface ReasonerProvenance {
  model: string;
  provider: "anthropic";
  promptVersion: string;
  decisionEngineVersion: string;
  /** The `accountDataVersion` the underlying evidence/packet was computed against (§10.1) —
   * "feature version" in §19.4's list. */
  featureVersion: number;
  /** Same counter as `featureVersion` today (both come from the one §10.1 monotonic version) —
   * kept as a distinct field because §19.4 lists them as two separate provenance items and a
   * future step may split "which feature recompute" from "which raw sync" into two counters. */
  dataVersion: number;
  generatedAt: string; // ISO instant
  /** The packet's own `createdAt` — the latest instant the underlying evidence is known fresh
   * through. Not a live "as of now" claim; a stale-but-cached packet is stamped honestly with
   * ITS OWN freshness, not the current wall clock. */
  dataFreshThrough: string; // ISO instant
  /** D3.1: the `adOptimizationKnowledge/{version}` doc actually injected into the prompt, or
   * `null` when none was loaded (an honest "no knowledge layer available", never a silent
   * omission from the provenance record). */
  adOptimizationKnowledgeVersion: string | null;
  stopReason: string;
  usage: ReasonerUsage;
}

export interface ReasonerResult {
  recommendation: RecommendationOutput;
  provenance: ReasonerProvenance;
  /** Every tool call the model made while producing this recommendation, in order — kept for
   * debugging/audit, not part of the stored recommendation itself. */
  toolCallLog: ReasonerToolCallLogEntry[];
}

export interface ReasonerToolCallLogEntry {
  toolName: string;
  input: unknown;
  isError: boolean;
}
