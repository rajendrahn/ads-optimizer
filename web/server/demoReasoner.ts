// D6 — a scripted, local-only stand-in for Claude Fable 5, matching the exact fake-client shape
// D3/D4's own emulator tests already use (`{ beta: { messages: { create } } } as unknown as
// Anthropic`, generateRecommendationTask.emulator.test.ts). Used ONLY when running this API
// locally without a configured Anthropic API key (the default — see deps.ts) or in this step's
// own tests. Never wired into any production code path: `services/reasoner/`/`services/reasoner/
// job/` are untouched, and web/server/deps.ts only reaches for this when
// `ANTHROPIC_LIVE` is unset.
//
// The real guardrail validator (`createGuardrailValidator` — D5, imported read-only from
// `services/reasoner/index.ts`) still runs against whatever this fake model proposes, so a demo
// run can genuinely produce a REJECTED card, not just a scripted one — see deps.ts.

import type Anthropic from "@anthropic-ai/sdk";
import type { DecisionPacket } from "@shared/schema/index.ts";
import type { RecommendationOutput } from "@services/reasoner/index.ts";

function textBlock(json: unknown): Anthropic.Beta.BetaTextBlock {
  return { type: "text", text: JSON.stringify(json), citations: null };
}

function usage(): Anthropic.Beta.BetaUsage {
  return {
    input_tokens: 1200,
    output_tokens: 300,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1000,
    cache_creation: null,
    fallback_credit: null,
    inference_geo: null,
    server_tool_use: null,
    speed: null,
  } as Anthropic.Beta.BetaUsage;
}

/**
 * Picks a plausible `RecommendationOutput` from the packet's own outcome/eligibility — never a
 * fixed canned answer regardless of what D1 actually found, so a demo run stays honest about
 * NOT_DELIVERING/NO_DECISION_UNIT/ineligible-to-scale packets (the model, real or fake, still has
 * to pass D1's own evidence through — this only stands in for the LLM's authoring of prose +
 * final numeric proposal, never for D1/D2's own evidence engine, which is the real one).
 */
export function scriptDemoRecommendation(packet: DecisionPacket): RecommendationOutput {
  if (packet.outcome !== "EVIDENCE") {
    // NOT_DELIVERING / NO_DECISION_UNIT — the only honest answer is INSUFFICIENT_DATA with no
    // decision unit, mirroring what the real prompt (prompt.ts) instructs the model to do with
    // these packet shapes.
    return {
      recommendation: "INSUFFICIENT_DATA",
      decisionUnit: null,
      currentBudgetMinorUnits: null,
      recommendedBudgetMinorUnits: null,
      changePercent: null,
      confidence: 0.2,
      summary:
        packet.outcome === "NOT_DELIVERING"
          ? "No budget decision is possible — the resolved decision unit is not delivering (zero spend and impressions in the primary window)."
          : "No budget decision is possible — no single decision unit could be resolved for this entity.",
      primaryReasons: [
        packet.textRendering?.split("\n").find((l) => l.trim().length > 0) ?? "See evidence.",
      ],
      risks: ["Re-ask once delivery resumes or budget ownership is unambiguous."],
      doNotDo: ["Do not propose a budget change with no decision unit or no delivery evidence."],
      recheckConditions: null,
    };
  }

  const evidence = packet.evidence as unknown as {
    decisionUnit: { type: "AD" | "ADSET" | "CAMPAIGN"; id: string };
    eligibleToScale: boolean;
    suggestedChangePercent: number | null;
    confidence: number;
    budgetOwner: { dailyBudgetMinorUnits: number | null; currency: string };
    evidence: { roas28d: { value: number | null; purchases: number } | null; targetRoas: number };
  };

  const currentBudget = evidence.budgetOwner.dailyBudgetMinorUnits ?? 50000;
  // AS_overlimit (seedDemo.ts) is a scripted exception, deliberately proposing a change far past
  // the default 20% guardrail ceiling (shared/canon/guardrailThresholds.ts's
  // DEFAULT_MAX_CHANGE_PERCENT) — this is what exercises D5's REAL, unmodified guardrail
  // validator end to end in a local demo run without a live model that might or might not
  // propose something over-limit on its own.
  const isOverLimitDemo = evidence.decisionUnit.id === "AS_overlimit";
  const changePercent = isOverLimitDemo
    ? 250
    : evidence.eligibleToScale
      ? (evidence.suggestedChangePercent ?? 15)
      : 0;
  const recommendedBudget = Math.round(currentBudget * (1 + changePercent / 100));
  const roas = evidence.evidence.roas28d;

  return {
    recommendation: isOverLimitDemo || evidence.eligibleToScale ? "INCREASE_BUDGET" : "HOLD",
    decisionUnit: evidence.decisionUnit,
    currentBudgetMinorUnits: currentBudget,
    recommendedBudgetMinorUnits: recommendedBudget,
    changePercent: isOverLimitDemo || evidence.eligibleToScale ? changePercent : 0,
    confidence: Math.min(0.9, Math.max(0.3, evidence.confidence)),
    summary: isOverLimitDemo
      ? `Increase the budget by ${changePercent}% — scripted demo output deliberately over the configured guardrail limit.`
      : evidence.eligibleToScale
        ? `Increase the budget by ${changePercent}% — 28-day performance clears the configured target with adequate volume.`
        : `Hold — the eligibility gate did not clear (see risks). This is a scripted demo answer, not a live Claude Fable 5 call.`,
    primaryReasons:
      roas?.value !== null && roas !== null
        ? [
            `28-day ROAS ${roas.value.toFixed(2)} on ${roas.purchases} purchases against a ${evidence.evidence.targetRoas} target.`,
          ]
        : ["See the evidence attached to this packet."],
    risks: [
      "This recommendation was produced by web/server's demo reasoner, not a live Claude Fable 5 call.",
    ],
    doNotDo: ["Do not treat this demo output as a real trading decision."],
    recheckConditions: evidence.eligibleToScale
      ? { minimumAdditionalSpendMinorUnits: 15000, minimumAdditionalPurchases: 15 }
      : null,
  };
}

/** Builds the scripted fake Anthropic client `createGenerateRecommendationHandler({client})`
 * expects — same shape as D3/D4's own tests. `packetLookup` is called once per request so the
 * script can react to whatever packet D2 actually built (see `scriptDemoRecommendation` above);
 * a demo entity id containing "faildemo" throws instead, to exercise the FAILED path on demand
 * (see web/server/seedDemo.ts).
 *
 * `getCurrentPacket` is called (and awaited) fresh on every `create()` invocation, not cached —
 * it must do a real Firestore read of whatever packet the CURRENT request's own
 * `generateAndCacheDecisionPacket` call just wrote (see deps.ts's `buildDemoRegistry`), since
 * that write always happens before this client is ever called (D4's own handler ordering:
 * packet built, then the model is called). */
export function createDemoAnthropicClient(
  getCurrentPacket: () => Promise<DecisionPacket | null>,
): Anthropic {
  const create = async (): Promise<{
    stop_reason: string;
    model: string;
    content: Anthropic.Beta.BetaContentBlock[];
    usage: Anthropic.Beta.BetaUsage;
  }> => {
    const packet = await getCurrentPacket();
    if (!packet) {
      throw new Error("demo reasoner: no decision packet was built before the model call");
    }
    if (packet.namedEntity?.id.includes("faildemo")) {
      throw new Error("demo reasoner: simulated Anthropic-side failure (ECONNRESET)");
    }
    const output = scriptDemoRecommendation(packet);
    return {
      stop_reason: "end_turn",
      model: "claude-fable-5-demo",
      content: [textBlock(output)],
      usage: usage(),
    };
  };
  return { beta: { messages: { create } } } as unknown as Anthropic;
}
