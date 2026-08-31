// §18 tool surface — shared shape every tool in this directory implements.
//
// CONTRACT (§18, restated in IMPLEMENTATION_PLAN.md D3's own Done-when): every tool returns
// pre-aggregated evidence with its uncertainty attached, never event-level or daily rows the
// model would have to sum. Concretely, that means every `execute` function below either:
//   (a) reads an already-aggregated Firestore document (an `EntityFeatures` window, a
//       `CreativeFamily`, a `DecisionPacket`/`ScalingEvidence`) and reshapes it, or
//   (b) aggregates internally over many raw rows (product mix over `shopifyOrderLines`) and
//       returns ONLY the aggregate (counts/sums grouped by category) — the raw rows it read
//       never leave the function.
// No tool here returns an array of individual orders, daily insight rows, or per-event data.
// See `services/reasoner/tools/index.test.ts`'s own "no raw rows" review, which asserts this
// structurally (every tool's declared output shape is a finite, named set of aggregate fields,
// never a rows/events/orders array of platform-level items).
//
// PII BOUNDARY (§17.2, enforced HERE, not in the prompt): no tool in this directory ever reads
// or returns `customerId`, name, email, address or phone. Shopify-derived tools (get_product_mix)
// aggregate across orders/lines and never surface a per-order or per-customer figure.

import type Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";
import type { ReasonerContext } from "../types.ts";

/** The SDK's own `input_schema` shape (`type: "object"` required, `[k: string]: unknown`
 * otherwise) — reused directly rather than a hand-rolled `Record<string, unknown>`, so a tool's
 * JSON Schema literal is checked against what the API actually requires at the point it's
 * written, not just at the point it's passed to `client.beta.messages.create`. */
export type ReasonerToolInputSchema = Anthropic.Beta.BetaTool.InputSchema;

export interface ReasonerTool<TInput> {
  name: string;
  description: string;
  /** Raw JSON Schema for the tool's `input_schema` — kept in the same restricted subset as
   * outputSchema.ts (no numerical/string constraints; `additionalProperties: false`). */
  inputSchema: ReasonerToolInputSchema;
  /** Validates/narrows the model-supplied `input` before `execute` ever sees it — malformed
   * tool input becomes a `tool_result` with `is_error: true`, never an unchecked `any`. */
  parseInput: (raw: unknown) => TInput;
  execute: (input: TInput, ctx: ReasonerContext) => Promise<unknown>;
}

/** Builds a `ReasonerTool` from a zod schema (validation) + a raw JSON Schema (what the API
 * sees) — kept as two separate values, not generated one from the other, for the same reason
 * outputSchema.ts hand-writes its JSON Schema: structured-output/tool JSON Schema support is a
 * restricted subset zod's own shapes don't map onto 1:1. */
export function defineTool<TInput>(spec: {
  name: string;
  description: string;
  inputSchema: ReasonerToolInputSchema;
  zodSchema: ZodType<TInput>;
  execute: (input: TInput, ctx: ReasonerContext) => Promise<unknown>;
}): ReasonerTool<TInput> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    parseInput: (raw) => spec.zodSchema.parse(raw),
    execute: spec.execute,
  };
}

export const SCALABLE_ENTITY_TYPE_JSON_ENUM = ["AD", "ADSET", "CAMPAIGN"] as const;
export const WINDOW_LABEL_JSON_ENUM = ["7d", "14d", "28d", "56d"] as const;
