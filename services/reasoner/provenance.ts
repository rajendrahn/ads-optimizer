// §19.4 provenance: "model, provider, prompt version, decision-engine version, feature version,
// data version, generated timestamp, data-fresh-through timestamp." Plus D3.1's own addition —
// the knowledge playbook version, so a recommendation names exactly which knowledge it used and
// a backtest can reconstruct it (D3.1's "Done when").

import type { DecisionPacket } from "@shared/schema/index.ts";
import type { AdOptimizationKnowledge } from "./knowledge.ts";
import { PROMPT_VERSION } from "./prompt.ts";
import type { ReasonerProvenance, ReasonerUsage } from "./types.ts";

/** D1's evidence engine has no version field of its own (it's a plain function, not a stored
 * artifact) — this constant is D3's own stamp for "which shape of the §14 evidence object this
 * recommendation was reasoned over", bumped by hand if D1/D2's evidence shape ever changes in a
 * way that would matter to a backtest replay. */
export const DECISION_ENGINE_VERSION = "d1-scaling-evidence-v1";

export function buildProvenance(input: {
  model: string;
  packet: DecisionPacket;
  knowledge: AdOptimizationKnowledge | null;
  stopReason: string;
  usage: ReasonerUsage;
  now?: Date;
}): ReasonerProvenance {
  const { model, packet, knowledge, stopReason, usage, now = new Date() } = input;
  return {
    model,
    provider: "anthropic",
    promptVersion: PROMPT_VERSION,
    decisionEngineVersion: DECISION_ENGINE_VERSION,
    featureVersion: packet.accountDataVersion,
    dataVersion: packet.accountDataVersion,
    generatedAt: now.toISOString(),
    dataFreshThrough: packet.createdAt.toISOString(),
    adOptimizationKnowledgeVersion: knowledge?.version ?? null,
    stopReason,
    usage,
  };
}
