// D4 — shared shapes for the job pipeline (§16.1). `requestRecommendation` (request.ts) writes
// the payload below and enqueues it under `GENERATE_RECOMMENDATION`;
// `generateRecommendationTask.ts`'s handler is the only reader.

import { z } from "zod";

/** Mirrors `@services/evidence`'s `ScalableEntityRef` shape exactly (AD/ADSET/CAMPAIGN only —
 * the same altitude restriction D1 imposes: a recommendation is always about one of these three,
 * never a CREATIVE_FAMILY or the ACCOUNT itself). Re-declared as a zod schema here (rather than
 * importing the TS-only interface) because this is what actually crosses the Cloud Tasks
 * boundary — `ctx.payload` in a `TaskHandler` is `unknown` until validated. */
export const generateRecommendationPayloadSchema = z.object({
  recommendationId: z.string().min(1),
  namedEntity: z.object({
    type: z.enum(["AD", "ADSET", "CAMPAIGN"]),
    id: z.string().min(1),
  }),
});
export type GenerateRecommendationPayload = z.infer<typeof generateRecommendationPayloadSchema>;

/** The request body `requestRecommendation`/`handleRecommendationRequest` (apiHandler.ts)
 * accept — the "API writes PENDING and enqueues" half of §16.1. */
export const recommendationRequestBodySchema = z.object({
  namedEntity: z.object({
    type: z.enum(["AD", "ADSET", "CAMPAIGN"]),
    id: z.string().min(1),
  }),
  requestedBy: z.string().nullable().optional(),
  requestedQuestion: z.string().nullable().optional(),
});
export type RecommendationRequestBody = z.infer<typeof recommendationRequestBodySchema>;
