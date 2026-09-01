// D4's own — the seam D5 (guardrail validator, §20.2) plugs into. Defined here, in the job
// pipeline, rather than in services/reasoner proper, because D3 deliberately stops at "propose a
// recommendation" and never validates it — see D3's "Notes for D4/D5": "guardrails must validate
// ... in code, exactly as §20.2 already specifies, with ZERO special-casing for
// provenance.adOptimizationKnowledgeVersion or anything the knowledge playbook said".
//
// **The structural guarantee this file exists to protect.** `GuardrailValidator`'s signature
// takes ONLY `RecommendationOutput` (D3's `types.ts`) — the model's own structured output. It has
// no parameter for `DecisionPacket`, `AdOptimizationKnowledge`, or `ReasonerProvenance`. This is
// not an oversight to fix later: D3.1's own live injection test (IMPLEMENTATION_PLAN.md D3's
// notes) proved that "a knowledge entry cannot change which code path validates the output,
// because the validator has no reference to the knowledge document at all" — and the only way
// that stays true after D4/D5 land is if the validator's own function signature makes it
// impossible to reach the knowledge document, not just a convention that says not to. Whoever
// implements D5's real validator should write a function matching this exact type; doing so
// keeps the guarantee structural rather than behavioural, per D3.1's own explicit instruction to
// "note this explicitly in D5".
//
// **Where this is called from.** generateRecommendationTask.ts's `createGenerateRecommendationHandler`
// takes a `guardrailValidator` option (defaulting to `passthroughGuardrailValidator` below) and
// calls it with exactly `reasonerResult.recommendation` — nothing else in scope at that call site
// is passed in. See that file's own comment for the REJECTED-branch handling (§20.2: downgraded
// to INSUFFICIENT_DATA, budget fields cleared, `guardrailRejection` stamped with the reason).
//
// **Status as of D4.** D5 has not landed yet (built concurrently — see IMPLEMENTATION_PLAN.md
// D5). `passthroughGuardrailValidator` always accepts, so a request flows PENDING -> GENERATING ->
// COMPLETE end to end without inventing guardrail logic this step is explicitly out of scope for.
// Swapping in D5's real validator is a one-line change at the `createGenerateRecommendationHandler()`
// call site in generateRecommendationTask.ts (the production registration) once it exists.

import type { RecommendationOutput } from "../types.ts";

export type GuardrailVerdict = { verdict: "ACCEPTED" } | { verdict: "REJECTED"; reason: string };

/**
 * D5's seam. Deliberately narrow: the ONLY input is the model's own structured output. See
 * module comment for why that narrowness is the actual guarantee, not incidental.
 */
export type GuardrailValidator = (
  recommendation: RecommendationOutput,
) => GuardrailVerdict | Promise<GuardrailVerdict>;

/** The default until D5 lands — always accepts. See module comment. */
export const passthroughGuardrailValidator: GuardrailValidator = () => ({ verdict: "ACCEPTED" });
