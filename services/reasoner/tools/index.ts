// §18's full tool surface, assembled. Order here is FIXED and must never depend on input data —
// §19.3's caching order starts with `tools`, and any tool-array reordering between calls
// invalidates the cache prefix just as surely as changed text would (see prompt.ts / the
// silent-invalidator note in reasoner.ts).

import type { ReasonerContext } from "../types.ts";
import { defineTool, type ReasonerTool } from "./types.ts";
import { resolveEntityTool } from "./resolveEntity.ts";
import { getPerformanceTool } from "./performance.ts";
import { getShopifyPerformanceTool } from "./shopifyPerformance.ts";
import { getAttributionHealthTool } from "./attributionHealth.ts";
import { getProductMixTool } from "./productMix.ts";
import { getRecentChangesTool } from "./recentChanges.ts";
import { getDeliveryStateTool } from "./deliveryState.ts";
import { getCreativeDetailsTool } from "./creativeDetails.ts";
import { getCreativeAssetTool } from "./creativeAsset.ts";
import { getCreativeFamilyTool } from "./creativeFamily.ts";
import { getFatigueAnalysisTool } from "./fatigueAnalysis.ts";
import { getSimilarAdsTool } from "./similarAds.ts";
import { getCampaignContextTool } from "./campaignContext.ts";
import { getBudgetConstraintsTool } from "./budgetConstraints.ts";
import { getDecisionEvidenceTool } from "./decisionEvidence.ts";

export { defineTool, type ReasonerTool };

/** Fixed order, matching §18's own listing left-to-right, top-to-bottom. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const REASONER_TOOLS: ReasonerTool<any>[] = [
  resolveEntityTool,
  getPerformanceTool,
  getShopifyPerformanceTool,
  getAttributionHealthTool,
  getProductMixTool,
  getRecentChangesTool,
  getDeliveryStateTool,
  getCreativeDetailsTool,
  getCreativeAssetTool,
  getCreativeFamilyTool,
  getFatigueAnalysisTool,
  getSimilarAdsTool,
  getCampaignContextTool,
  getBudgetConstraintsTool,
  getDecisionEvidenceTool,
];

/** The Anthropic-API-shaped tool definitions, in the same fixed order — passed verbatim as the
 * request's `tools` array (§19.3: first in the cached prefix). */
export function reasonerToolDefinitions() {
  return REASONER_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

/** Dispatches one `tool_use` call by name. Unknown tool name or invalid input both come back as
 * an `is_error` tool result (never a thrown exception that would abort the whole turn) — §17.3/
 * §18's contract is about what a SUCCESSFUL tool call returns; a malformed call is handled the
 * same way any tool-use loop handles a bad call, so Claude can recover mid-conversation. */
export async function executeReasonerTool(
  name: string,
  rawInput: unknown,
  ctx: ReasonerContext,
): Promise<ToolExecutionResult> {
  const tool = REASONER_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { content: `Unknown tool "${name}".`, isError: true };
  }
  try {
    const input = tool.parseInput(rawInput);
    const result = await tool.execute(input, ctx);
    return { content: JSON.stringify(result, null, 2), isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Tool "${name}" failed: ${message}`, isError: true };
  }
}
