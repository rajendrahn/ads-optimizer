// §4.1 rule 1: "Budget decisions resolve at the budget owner ... that owner is the decision
// unit." Pure resolution logic — no Firestore here, so every branch is directly unit-testable;
// entityLookup.ts is the thin Firestore-fetching wrapper that gathers the inputs this needs.
//
// B2's live measurement (IMPLEMENTATION_PLAN.md B2's notes) is the ground truth this module is
// built against: of 410 real campaigns, 369 own budget outright, 37 defer to a single ad set, and
// 4 are genuinely UNKNOWN (old orphaned campaigns with no ad sets and no budget signal at all).
// Zero ads own a budget — Meta's model has no such concept — so a named AD always escalates.

import type { BudgetOwnership, MetaAd, MetaAdset, MetaCampaign } from "@shared/schema/index.ts";
import type { DecisionUnitResolution, EscalationReason, ScalableEntityRef } from "./types.ts";

/** One child ad set's own budget field, for the CAMPAIGN-named-entity "which ad set actually
 * owns it" check. Only `adsetId`/`budget` are needed — see resolveCampaignDeferral. */
export interface ChildAdsetBudget {
  adsetId: string;
  budget: BudgetOwnership | null;
}

function campaignBudgetVerdict(campaign: MetaCampaign): "OWNS" | "DEFERS" | "UNKNOWN" {
  if (campaign.budget === null) return "DEFERS";
  if (campaign.budget.ownerLevel === "CAMPAIGN") return "OWNS";
  // ownerLevel "UNKNOWN" (the only other value B2 ever stores on a campaign's own `.budget`;
  // "ADSET" never appears there — see budgetOwnership.ts's determineCampaignBudgetGivenChildren).
  return "UNKNOWN";
}

function adsetBudgetVerdict(adset: MetaAdset): "OWNS" | "UNKNOWN" {
  // Reached only when the parent campaign DEFERS, in which case B2's determineAdsetBudget
  // guarantees adset.budget is non-null (either a real ADSET-owning value or an explicit
  // UNKNOWN placeholder) — see that module's own case table. A null here would mean the two
  // snapshots (campaign, ad set) were read at different moments and briefly disagree; treated
  // the same as UNKNOWN rather than guessed, since it is the same "do not guess a level"
  // situation §4.1 describes.
  if (adset.budget === null) return "UNKNOWN";
  if (adset.budget.ownerLevel === "ADSET") return "OWNS";
  return "UNKNOWN";
}

/**
 * Resolves the budget owner for an AD or ADSET named entity, given its own doc and its parent
 * campaign's doc. Shared by both cases below since an ADSET's resolution is exactly "the AD
 * case minus the ad-specific escalation reason".
 */
function resolveViaCampaign(
  adsetId: string,
  adset: MetaAdset,
  campaign: MetaCampaign,
): DecisionUnitResolution {
  const campaignVerdict = campaignBudgetVerdict(campaign);
  if (campaignVerdict === "UNKNOWN") {
    return {
      kind: "NO_DECISION_UNIT",
      detail:
        `Campaign ${campaign.campaignId} has no resolvable budget owner (Meta's own config is ` +
        `ambiguous — both or neither of the campaign/ad-set levels report a budget). §4.1: budget ` +
        `ownership can legitimately be UNKNOWN; no decision unit can be identified here.`,
    };
  }
  if (campaignVerdict === "OWNS") {
    return {
      kind: "RESOLVED",
      decisionUnit: { type: "CAMPAIGN", id: campaign.campaignId },
    };
  }
  // DEFERS — the named ad set's own budget field is the answer.
  const adsetVerdict = adsetBudgetVerdict(adset);
  if (adsetVerdict === "UNKNOWN") {
    return {
      kind: "NO_DECISION_UNIT",
      detail:
        `Ad set ${adsetId} has no resolvable budget owner — its campaign (${campaign.campaignId}) ` +
        `does not own budget, and the ad set's own budget signal is itself ambiguous or absent. ` +
        `§4.1: budget ownership can legitimately be UNKNOWN; no decision unit can be identified here.`,
    };
  }
  return { kind: "RESOLVED", decisionUnit: { type: "ADSET", id: adsetId } };
}

/** CAMPAIGN case's own DEFERS branch: unlike an AD/ADSET, a named campaign that defers may defer
 * to more than one independently-owning ad set (ABO with several ad sets under one campaign) —
 * B2's own `determineCampaignBudgetGivenChildren` only checks "does ANY ad set own budget", not
 * uniqueness. A D1-specific extension of §4.1's own "do not guess a level" principle: more than
 * one owner is exactly as unresolvable as none. */
function resolveCampaignDeferral(
  campaign: MetaCampaign,
  childAdsets: readonly ChildAdsetBudget[],
): DecisionUnitResolution {
  const owning = childAdsets.filter((a) => a.budget !== null && a.budget.ownerLevel === "ADSET");
  if (owning.length === 1) {
    return { kind: "RESOLVED", decisionUnit: { type: "ADSET", id: owning[0].adsetId } };
  }
  if (owning.length === 0) {
    return {
      kind: "NO_DECISION_UNIT",
      detail:
        `Campaign ${campaign.campaignId} defers budget ownership to its ad sets, but none of its ` +
        `child ad sets report owning a budget either. §4.1: budget ownership can legitimately be ` +
        `UNKNOWN; no decision unit can be identified here.`,
    };
  }
  return {
    kind: "NO_DECISION_UNIT",
    detail:
      `Campaign ${campaign.campaignId} has ${owning.length} ad sets that independently own their ` +
      `own budget (ABO) — there is no single decision unit for a campaign-level request. Ask about ` +
      `one of its ad sets directly: ${owning.map((a) => a.adsetId).join(", ")}.`,
  };
}

/** §14's own literal reason string, used only when the named AD's own volume is the driver.
 * `floor`/`sampleSize` are the primary-window purchase floor and the ad's own primary-window
 * purchase count — both optional because they may be unavailable (no feature doc yet for a
 * brand-new ad); when unavailable, the reason falls back to the always-true structural one. */
function adEscalationReason(sampleSize: number | null, floor: number | null): EscalationReason {
  if (sampleSize !== null && floor !== null && sampleSize < floor) return "SAMPLE_TOO_SMALL";
  return "AD_NOT_BUDGET_OWNER";
}

export interface ResolveDecisionUnitInput {
  namedEntity: ScalableEntityRef;
  ad?: MetaAd | null;
  adset?: MetaAdset | null;
  campaign?: MetaCampaign | null;
  /** Only needed when namedEntity is a CAMPAIGN whose own `.budget` is null. */
  childAdsetBudgets?: readonly ChildAdsetBudget[];
  /** Only used for the AD case's escalation reason — see adEscalationReason. */
  adPrimaryWindowSampleSize?: number | null;
  adPrimaryWindowMinPurchaseFloor?: number | null;
}

/**
 * §4.1's decision-unit resolution, pure. Every branch either resolves to a real CAMPAIGN/ADSET
 * decision unit (with `escalatedFrom` set whenever the named entity itself is NOT that decision
 * unit) or reports `NO_DECISION_UNIT` with a human-readable reason — never guesses a level.
 */
export function resolveDecisionUnit(input: ResolveDecisionUnitInput): DecisionUnitResolution {
  const { namedEntity } = input;

  if (namedEntity.type === "CAMPAIGN") {
    if (!input.campaign) {
      return {
        kind: "NO_DECISION_UNIT",
        detail: `Campaign ${namedEntity.id} was not found in the synced Meta entity data.`,
      };
    }
    const verdict = campaignBudgetVerdict(input.campaign);
    if (verdict === "OWNS") {
      return { kind: "RESOLVED", decisionUnit: { type: "CAMPAIGN", id: namedEntity.id } };
    }
    if (verdict === "UNKNOWN") {
      return {
        kind: "NO_DECISION_UNIT",
        detail:
          `Campaign ${namedEntity.id} has no resolvable budget owner (Meta's own config is ` +
          `ambiguous). §4.1: budget ownership can legitimately be UNKNOWN.`,
      };
    }
    return resolveCampaignDeferral(input.campaign, input.childAdsetBudgets ?? []);
  }

  if (namedEntity.type === "ADSET") {
    if (!input.adset || !input.campaign) {
      return {
        kind: "NO_DECISION_UNIT",
        detail: `Ad set ${namedEntity.id} or its parent campaign was not found in the synced Meta entity data.`,
      };
    }
    const resolution = resolveViaCampaign(namedEntity.id, input.adset, input.campaign);
    if (resolution.kind === "RESOLVED" && resolution.decisionUnit.type === "CAMPAIGN") {
      return {
        kind: "RESOLVED",
        decisionUnit: resolution.decisionUnit,
        escalatedFrom: { type: "ADSET", id: namedEntity.id, reason: "ADSET_NOT_BUDGET_OWNER" },
      };
    }
    return resolution; // either resolved to the named ad set itself (no escalation), or UNKNOWN
  }

  // AD — always escalates: Meta's model gives an ad no budget of its own (B2's live 0-of-1,139
  // finding), so every ad-named request necessarily answers at its ad set or campaign.
  if (!input.ad || !input.adset || !input.campaign) {
    return {
      kind: "NO_DECISION_UNIT",
      detail: `Ad ${namedEntity.id}, its ad set, or its campaign was not found in the synced Meta entity data.`,
    };
  }
  const resolution = resolveViaCampaign(input.ad.adsetId, input.adset, input.campaign);
  if (resolution.kind === "NO_DECISION_UNIT") return resolution;
  const reason = adEscalationReason(
    input.adPrimaryWindowSampleSize ?? null,
    input.adPrimaryWindowMinPurchaseFloor ?? null,
  );
  return {
    kind: "RESOLVED",
    decisionUnit: resolution.decisionUnit,
    escalatedFrom: { type: "AD", id: namedEntity.id, reason },
  };
}
