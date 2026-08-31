// §20.1 structured output via `output_config.format` (§19.3: "Shape responses with
// output_config.format" — there is no assistant prefill on Fable 5). The JSON Schema below is
// hand-written to match `recommendationOutputSchema` (types.ts) field-for-field rather than
// generated through a zod-to-JSON-Schema helper, because the structured-outputs feature only
// supports a restricted JSON Schema subset (no numerical/string constraints, no `$ref` needed
// here, `additionalProperties: false` required on every object) — see the claude-api skill's
// "JSON Schema Limitations". Writing it by hand keeps every field's shape visibly in sync with
// that restriction instead of hoping a generator's output happens to fit it.
//
// `RECOMMENDATION_TYPES` is imported from the same zod enum D1/D2 already use
// (`recommendationTypeSchema`), not retyped — one source of truth for the allowed values.

import { recommendationTypeSchema } from "@shared/schema/index.ts";

const RECOMMENDATION_TYPES = recommendationTypeSchema.options;

const decisionUnitSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["AD", "ADSET", "CAMPAIGN"] },
    id: { type: "string" },
  },
  required: ["type", "id"],
  additionalProperties: false,
} as const;

const recheckConditionsSchema = {
  type: "object",
  properties: {
    minimumAdditionalSpendMinorUnits: { type: ["integer", "null"] },
    minimumAdditionalPurchases: { type: ["integer", "null"] },
  },
  required: ["minimumAdditionalSpendMinorUnits", "minimumAdditionalPurchases"],
  additionalProperties: false,
} as const;

/** The raw JSON Schema handed to `output_config.format` — see module comment. */
export const RECOMMENDATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    recommendation: { type: "string", enum: RECOMMENDATION_TYPES },
    decisionUnit: { anyOf: [decisionUnitSchema, { type: "null" }] },
    currentBudgetMinorUnits: { type: ["integer", "null"] },
    recommendedBudgetMinorUnits: { type: ["integer", "null"] },
    changePercent: { type: ["number", "null"] },
    confidence: { type: "number" },
    summary: { type: "string" },
    primaryReasons: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    doNotDo: { type: "array", items: { type: "string" } },
    recheckConditions: { anyOf: [recheckConditionsSchema, { type: "null" }] },
  },
  required: [
    "recommendation",
    "decisionUnit",
    "currentBudgetMinorUnits",
    "recommendedBudgetMinorUnits",
    "changePercent",
    "confidence",
    "summary",
    "primaryReasons",
    "risks",
    "doNotDo",
    "recheckConditions",
  ],
  additionalProperties: false,
} as const;

/** `output_config.format` value for `client.beta.messages.create` — see reasoner.ts. */
export const RECOMMENDATION_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: RECOMMENDATION_JSON_SCHEMA as unknown as Record<string, unknown>,
};
