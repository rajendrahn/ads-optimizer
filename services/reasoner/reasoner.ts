// D3 — the reasoner proper: runs Claude Fable 5 over one decision packet, with tool access, and
// returns a schema-valid structured recommendation plus its provenance. See prompt.ts for the
// §19.3 caching order and knowledge.ts for D3.1's playbook layer; this file is the request/tool
// loop and the §19.3 API-behaviour rules (thinking always on, no sampling params, no prefill,
// check stop_reason before reading content, server-side fallbacks).

import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_MODEL } from "../../scripts/config.ts";
import type { DecisionPacket } from "@shared/schema/index.ts";
import { createReasonerClient } from "./client.ts";
import { loadActiveAdOptimizationKnowledge, type AdOptimizationKnowledge } from "./knowledge.ts";
import { buildSystemBlocks, buildUserContentBlocks } from "./prompt.ts";
import { RECOMMENDATION_OUTPUT_FORMAT } from "./outputSchema.ts";
import {
  recommendationOutputSchema,
  type ReasonerResult,
  type ReasonerToolCallLogEntry,
} from "./types.ts";
import { buildProvenance } from "./provenance.ts";
import { executeReasonerTool, reasonerToolDefinitions } from "./tools/index.ts";
import type { ReasonerContext } from "./types.ts";

const MAX_TOOL_ITERATIONS = 8;
// Fable 5's thinking tokens count against max_tokens (thinking is always on — §19.3). The
// claude-api skill's own default for a non-streaming request is ~16000, specifically to leave
// room for thinking + tool-call overhead before the final structured JSON; 8000 was too tight in
// practice and could truncate a real turn mid-thought before D3's own structured output.
const MAX_TOKENS = 16000;

export class ReasonerRefusalError extends Error {
  constructor(
    message: string,
    public readonly category: string | null,
  ) {
    super(message);
    this.name = "ReasonerRefusalError";
  }
}

export interface GenerateRecommendationOptions {
  ctx: ReasonerContext;
  packet: DecisionPacket;
  /** Overrides `scripts/config.ts`'s `ANTHROPIC_MODEL` — used by tests only. */
  model?: string;
  /** `output_config.effort` — §19.2 defaults to "high"; overridable per call (e.g. lower for a
   * cheap smoke test). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  client?: Anthropic;
  now?: Date;
}

function findText(content: Anthropic.Beta.BetaContentBlock[]): string | null {
  for (const block of content) {
    if (block.type === "text") return block.text;
  }
  return null;
}

/**
 * Runs the full tool loop for one decision packet and returns a schema-valid recommendation.
 * Throws `ReasonerRefusalError` if the model (and its configured fallback) both decline, and a
 * plain `Error` for `max_tokens`/an exhausted tool-iteration budget/a structured-output parse
 * failure — none of these are silently swallowed into a fabricated recommendation.
 */
export async function generateRecommendation(
  options: GenerateRecommendationOptions,
): Promise<ReasonerResult> {
  const { ctx, packet, model = ANTHROPIC_MODEL, effort = "high", now = new Date() } = options;
  if (packet.textRendering === null) {
    throw new Error("generateRecommendation: packet has no textRendering to reason over");
  }

  const client = await createReasonerClient({ clientOverride: options.client });
  const knowledge: AdOptimizationKnowledge | null = await loadActiveAdOptimizationKnowledge(ctx.db);

  const tools = reasonerToolDefinitions();
  const system = buildSystemBlocks(knowledge);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: buildUserContentBlocks(ctx.canon, packet.textRendering) },
  ];

  const toolCallLog: ReasonerToolCallLogEntry[] = [];
  let lastUsage: Anthropic.Beta.BetaUsage | null = null;
  let lastModel = model;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      // §19.3: thinking is always on for Fable 5 — the `thinking` parameter is OMITTED
      // entirely, never set to `{type:"disabled"}` or given a `budget_tokens` (both 400).
      // §19.3: no sampling parameters (`temperature`/`top_p`/`top_k`) — omitted, not zeroed.
      output_config: { effort, format: RECOMMENDATION_OUTPUT_FORMAT },
      tools,
      system,
      messages,
      // §19.1/§19.3: server-side fallbacks — Fable 5 can return stop_reason "refusal"; this
      // routes a declined request to Anthropic's recommended fallback automatically, server-side.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    lastUsage = response.usage;
    lastModel = response.model;

    // §19.3: ALWAYS check stop_reason before reading content.
    if (response.stop_reason === "refusal") {
      throw new ReasonerRefusalError(
        `Claude declined this request (category: ${response.stop_details?.category ?? "unknown"})`,
        response.stop_details?.category ?? null,
      );
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `generateRecommendation: hit max_tokens (${MAX_TOKENS}) before finishing — raise MAX_TOKENS`,
      );
    }

    if (response.stop_reason === "tool_use" || response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (toolUseBlocks.length === 0) {
        // pause_turn with nothing to execute (e.g. a paused server-tool turn we don't use) —
        // resume by re-sending as-is, matching the skill's own pause_turn handling pattern.
        continue;
      }

      const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const result = await executeReasonerTool(toolUse.name, toolUse.input, ctx);
        toolCallLog.push({ toolName: toolUse.name, input: toolUse.input, isError: result.isError });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: result.isError,
        });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    if (response.stop_reason === "end_turn") {
      const text = findText(response.content);
      if (text === null) {
        throw new Error(
          "generateRecommendation: model ended the turn with no text content to parse",
        );
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch (cause) {
        throw new Error(
          `generateRecommendation: final response text was not valid JSON: ${text.slice(0, 500)}`,
          { cause },
        );
      }
      // Defense in depth: output_config.format already constrains the API response; re-validate
      // client-side against the same zod schema before trusting it any further.
      const recommendation = recommendationOutputSchema.parse(parsedJson);

      const usage = lastUsage;
      if (!usage) throw new Error("generateRecommendation: no usage recorded — unreachable");

      return {
        recommendation,
        provenance: buildProvenance({
          model: lastModel,
          packet,
          knowledge,
          stopReason: response.stop_reason,
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheCreationInputTokens: usage.cache_creation_input_tokens,
            cacheReadInputTokens: usage.cache_read_input_tokens,
          },
          now,
        }),
        toolCallLog,
      };
    }

    throw new Error(`generateRecommendation: unexpected stop_reason "${response.stop_reason}"`);
  }

  throw new Error(
    `generateRecommendation: exceeded ${MAX_TOOL_ITERATIONS} tool-use iterations without a final answer`,
  );
}
