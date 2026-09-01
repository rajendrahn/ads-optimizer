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
// (guardrailLog.ts) is the higher-fidelity integration — same core, plus logging every rejection
// to `guardrailRejections/{recommendationId}` and shaping the INSUFFICIENT_DATA downgrade patch —
// meant to be called directly from inside `generateRecommendationTask.ts` where the real
// recommendationId/namedEntity/accountDataVersion are already in scope (see IMPLEMENTATION_PLAN.md
// D5's "Notes for D4"). `createGuardrailValidator` (guardrailAdapter.ts) is a drop-in adapter
// conforming to D4's own narrower `GuardrailValidator` type (services/reasoner/job/
// guardrailSeam.ts) for a zero-touch swap at the CURRENT call site — see that file's own module
// comment for the fidelity trade-off between the two integration paths.
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
export { createGuardrailValidator, type CreateGuardrailValidatorDeps } from "./guardrailAdapter.ts";
