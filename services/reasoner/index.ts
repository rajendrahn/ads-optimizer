// D3 barrel — Claude integration and tools (§18, §19, §20.1). D4's job pipeline and D5's
// guardrail validator both consume `generateRecommendation`'s result; see this module's own
// files for the shapes each returns.

export { createReasonerClient, __resetReasonerClientForTests } from "./client.ts";
export { wrapUntrusted, wrapUntrustedBlock } from "./untrustedContent.ts";
export {
  adOptimizationKnowledgeEntrySchema,
  adOptimizationKnowledgeSchema,
  loadActiveAdOptimizationKnowledge,
  refreshAdOptimizationKnowledge,
  renderKnowledgeForPrompt,
  SEED_KNOWLEDGE_V1,
  type AdOptimizationKnowledge,
  type AdOptimizationKnowledgeEntry,
} from "./knowledge.ts";
export { RECOMMENDATION_JSON_SCHEMA, RECOMMENDATION_OUTPUT_FORMAT } from "./outputSchema.ts";
export {
  PROMPT_VERSION,
  STABLE_SYSTEM_TEXT,
  buildAccountContextText,
  buildSystemBlocks,
  buildUserContentBlocks,
} from "./prompt.ts";
export { DECISION_ENGINE_VERSION, buildProvenance } from "./provenance.ts";
export { generateRecommendation, ReasonerRefusalError } from "./reasoner.ts";
export {
  recommendationDecisionUnitSchema,
  recommendationOutputSchema,
  recommendationRecheckConditionsSchema,
  type ReasonerContext,
  type ReasonerProvenance,
  type ReasonerResult,
  type ReasonerToolCallLogEntry,
  type ReasonerUsage,
  type RecommendationOutput,
} from "./types.ts";
export { REASONER_TOOLS, executeReasonerTool, reasonerToolDefinitions } from "./tools/index.ts";
