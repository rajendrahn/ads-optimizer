// D4 barrel — the recommendation job pipeline (§16.1). Deliberately does NOT re-export
// server.ts: that file starts a real HTTP listener as a module-level side effect (Cloud Run's own
// entrypoint contract — see its own comment), so nothing should import it except the process
// actually meant to run as that server. Every other file here is a plain, side-effect-free
// module, safe to import from tests or from a future D6 API route.

export {
  requestRecommendation,
  type RequestRecommendationOptions,
  type RequestRecommendationResult,
} from "./request.ts";
export {
  handleRecommendationRequest,
  type HandleRecommendationRequestDeps,
  type RecommendationRequestResponse,
  type RecommendationRequestResponseBody,
} from "./apiHandler.ts";
export { getApiRuntimeDeps } from "./apiRuntime.ts";
export {
  createGenerateRecommendationHandler,
  generateRecommendationHandler,
  generateRecommendationRegistration,
  type GenerateRecommendationHandlerDeps,
} from "./generateRecommendationTask.ts";
export { createReasonerWorkerRegistry } from "./workerRegistry.ts";
export { handleReasonerTaskDispatch } from "./workerRuntime.ts";
export {
  passthroughGuardrailValidator,
  type GuardrailValidator,
  type GuardrailVerdict,
} from "./guardrailSeam.ts";
export {
  generateRecommendationPayloadSchema,
  recommendationRequestBodySchema,
  type GenerateRecommendationPayload,
  type RecommendationRequestBody,
} from "./types.ts";
