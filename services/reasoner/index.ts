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

// D5 — the guardrail validator (§20.2). `validateGuardrails` (guardrails.ts) is the pure decision
// core: model's structured output + D1's independently-computed evidence + settings in, an
// APPROVED/REJECTED decision out — no reference to the knowledge document anywhere in its inputs
// (see that file's own module comment for the structural guarantee this is). `applyGuardrails`
// (guardrailLog.ts) is the ONLY production integration — same core, plus logging every rejection
// to `guardrailRejections/{recommendationId}` and shaping the INSUFFICIENT_DATA downgrade patch —
// called directly from inside `generateRecommendationTask.ts`'s own task handler, where the real
// `recommendationId`/`namedEntity`/`accountDataVersion`/`adOptimizationKnowledgeVersion` are
// already in scope. A second, narrower integration path (`createGuardrailValidator`,
// `guardrailAdapter.ts`, conforming to a `GuardrailValidator` seam in
// `services/reasoner/job/guardrailSeam.ts`) existed briefly after D4/D5 landed concurrently; it
// synthesized a fake id for the rejection log because the narrow seam had no real
// `recommendationId` in scope, making that log unjoinable to the recommendation it rejected —
// both files were deleted once `generateRecommendationTask.ts` was fixed to call `applyGuardrails`
// directly (see that file's own corrective note, and IMPLEMENTATION_PLAN.md D4/D5's notes).
export {
  validateGuardrails,
  type GuardrailApproval,
  type GuardrailDecision,
  type GuardrailInput,
  type GuardrailRejection,
} from "./guardrails.ts";
export {
  applyGuardrails,
  logGuardrailRejection,
  type ApplyGuardrailsInput,
  type GuardrailApplication,
  type GuardrailRejectionRecommendationPatch,
  type LogGuardrailRejectionInput,
} from "./guardrailLog.ts";
