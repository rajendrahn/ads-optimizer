// D2's own deliverable, and — per this step's own brief — "the whole point of this step, not a
// nicety": rendering D1's ScalingEvidenceResult into the prose the model actually reasons OVER
// (§15.2), not past. Every number this module writes into a sentence is read straight off the
// already-computed ScalingEvidence object — this module formats, it never computes.
//
// Six things §15.2/§24/§6.2/reality #4/#5/#6 all converge on being required IN THE TEXT, not
// only reachable via the JSON, and where each comes from:
//   1. Every ROAS/CPA with its sample size and interval — `metricLine`/`moneyMetricLine` below,
//      applied to every populated window, not only the primary one.
//   2. The verdict AND its reason — `MetricSnapshot.verdictReason` (D1's `verdictExplain.ts`)
//      rendered verbatim after each metric line.
//   3. Escalation, prominently — `renderEscalationBlock`, placed first in the body, before any
//      metric.
//   4. Attribution coverage — `renderAttributionBlock` renders D1's own always-populated
//      `evidence.shopify.note` verbatim, plus the coverage ratios and blended MER, and labels
//      every Shopify-attributed figure as such right next to the caveat (§6.2/§6.3: never
//      merged, never presented as if reliable at this account's coverage).
//   5. Seasonality — `evidence.evidence.seasonality.summaryText` (C5's own honest "no index and
//      why" prose for this account's n=1 real-label history), rendered verbatim.
//   6. Which target a verdict was judged against — `renderTargetsBlock`, naming the actual
//      numbers AND `targets.source`, with an explicit placeholder warning when the source is the
//      built-in default rather than an operator-supplied one.

import { formatMinorUnitsAsDecimal, makeMoney } from "@shared/canon/index.ts";
import type {
  EscalatedFrom,
  EscalationReason,
  IneligibilityReason,
  MetricSnapshot,
  ScalingEvidence,
  ScalingEvidenceResult,
  WindowEvidence,
} from "./types.ts";

/** Formats a minor-units figure (CPA, spend, budget) as "{CODE} {decimal}" — e.g. "INR 1761.00".
 * Deliberately the ISO code, not a currency symbol: `formatMinorUnitsAsDecimal` (§0.2/§5.2's own
 * money module) only ever produces the digits, and this codebase has no symbol table to draw
 * from — inventing one here would be exactly the kind of silent, unreviewed convention §0.2
 * warns against. */
function money(minorUnits: number, currency: string): string {
  return `${currency} ${formatMinorUnitsAsDecimal(makeMoney(Math.round(minorUnits), currency))}`;
}

function formatRatio(value: number | null): string {
  if (value === null) return "not available";
  return `${(value * 100).toFixed(3)}%`;
}

const ESCALATION_REASON_PROSE: Record<EscalationReason, string> = {
  SAMPLE_TOO_SMALL:
    "the named ad's own purchase count in the primary window is below the statistical floor " +
    "needed for a confident read",
  AD_NOT_BUDGET_OWNER:
    "Meta's own model gives an individual ad no budget of its own — an ad is never a budget " +
    "decision unit, regardless of its own volume",
  ADSET_NOT_BUDGET_OWNER:
    "this ad set does not own its budget — its campaign does (Campaign Budget Optimization)",
  CAMPAIGN_NOT_BUDGET_OWNER:
    "this campaign does not own its budget — an ad set beneath it does (Ad Set Budget " +
    "Optimization), or (see the packet's decision-unit line) more than one ad set independently " +
    "does",
};

function renderEscalationBlock(
  escalatedFrom: EscalatedFrom | undefined | null,
  resolvedName: string,
): string {
  if (!escalatedFrom) return "";
  const reason = ESCALATION_REASON_PROSE[escalatedFrom.reason] ?? escalatedFrom.reason;
  return (
    `\n⚠ ESCALATED — read this before any number below.\n` +
    `You asked about ${escalatedFrom.type} ${escalatedFrom.id}. This packet does NOT answer at ` +
    `that level: ${reason}. It answers instead for the entity that actually owns the budget — ` +
    `${resolvedName} — because that escalation, done and named, is a better answer than ` +
    `"INSUFFICIENT_DATA" and a dead end (§4.1).\n`
  );
}

/** One ROAS-shaped metric (unitless ratio) — value/interval/purchases/verdict/reason, all in the
 * sentence itself, never left for a reader to go find in the JSON (§15.2, §24's own display
 * rule: "never show a ROAS without its sample size"). */
function ratioMetricLine(label: string, snap: MetricSnapshot): string {
  if (snap.value === null) {
    return `  - ${label}: not measured. ${snap.verdictReason}`;
  }
  const [low, high] = snap.interval;
  const interval =
    low !== null && high !== null
      ? `${low.toFixed(2)}x–${high.toFixed(2)}x`
      : "no interval available";
  return (
    `  - ${label}: ${snap.value.toFixed(2)}x (interval ${interval}) on ${snap.purchases} ` +
    `purchase${snap.purchases === 1 ? "" : "s"} — ${snap.verdict ?? "NO_VERDICT"}. ${snap.verdictReason}`
  );
}

/** Same shape, for a money-valued metric (CPA) — minor units formatted through the canon's own
 * money module (§0.2: never a bare integer presented as if it were decimal currency). */
function moneyMetricLine(label: string, snap: MetricSnapshot, currency: string): string {
  if (snap.value === null) {
    return `  - ${label}: not measured. ${snap.verdictReason}`;
  }
  const [low, high] = snap.interval;
  const interval =
    low !== null && high !== null
      ? `${money(low, currency)}–${money(high, currency)}`
      : "no interval available";
  return (
    `  - ${label}: ${money(snap.value, currency)} (interval ${interval}) on ${snap.purchases} ` +
    `purchase${snap.purchases === 1 ? "" : "s"} — ${snap.verdict ?? "NO_VERDICT"}. ${snap.verdictReason}`
  );
}

function renderWindowBlock(label: string, w: WindowEvidence, currency: string): string {
  const lines = [
    `${label} window (spend ${money(w.spendMinorUnits, currency)}):`,
    ratioMetricLine("Meta ROAS", w.metaRoas),
    w.metaRoasShrunk !== null
      ? `    shrunk toward account mean: ${w.metaRoasShrunk.toFixed(2)}x (§15.3 — compare post-change performance against THIS, never the raw figure)`
      : null,
    moneyMetricLine("CPA (Meta)", w.cpaMinorUnits, currency),
    ratioMetricLine("Shopify ROAS", w.shopifyRoas),
    w.shopifyDataGap?.windowHasDataGap
      ? `    Shopify data gap in this window: ${w.shopifyDataGap.gapDays.slice(0, 5).join(", ")}${w.shopifyDataGap.gapDays.length > 5 ? ` (+${w.shopifyDataGap.gapDays.length - 5} more)` : ""} — the Shopify-attributed figures above are unreliable for these days specifically.`
      : null,
    `  - Attribution coverage this window: ${formatRatio(w.attributionCoverageRatio)} (Shopify-attributed purchases ÷ Meta-reported purchases).`,
    w.ctr !== null || w.cvr !== null
      ? `  - CTR ${w.ctr !== null ? (w.ctr * 100).toFixed(2) + "%" : "n/a"}, CVR ${w.cvr !== null ? (w.cvr * 100).toFixed(2) + "%" : "n/a"}, frequency ${w.frequency !== null ? w.frequency.toFixed(2) : "n/a"}.`
      : null,
    w.seasonality.summaryText ? `  - Seasonality: ${w.seasonality.summaryText}` : null,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

function renderAttributionBlock(evidence: ScalingEvidence): string {
  const s = evidence.evidence.shopify;
  return (
    `ATTRIBUTION COVERAGE.\n` +
    `${s.note}\n` +
    `  - attributionCoverageRatio (UTM ID match only, the trustworthy figure): ${formatRatio(s.attributionCoverageRatio)}\n` +
    `  - attributionCoverageRatioIncludingNameMatch (looser, includes name-based matches): ${formatRatio(s.attributionCoverageRatioIncludingNameMatch)}\n` +
    `  - blendedMerAccountOnly (Shopify revenue ÷ Meta spend, no per-order join, ACCOUNT level only): ` +
    `${s.blendedMerAccountOnly !== null ? s.blendedMerAccountOnly.toFixed(2) + "x" : "not available at this decision unit's altitude (only ever populated at ACCOUNT level)"}`
  );
}

function renderTargetsBlock(evidence: ScalingEvidence): string {
  const t = evidence.targets;
  const placeholderWarning =
    t.source === "default"
      ? " These are PLACEHOLDER defaults, not this account's real business targets — treat any " +
        "verdict below with appropriate skepticism; a verdict is only as good as the target it " +
        "was judged against, and this one has not yet been confirmed by the operator."
      : " These are the operator's own configured targets (settings/{accountId}.statisticalThresholds).";
  return (
    `TARGETS THIS PACKET WAS JUDGED AGAINST (source: ${t.source}).${placeholderWarning}\n` +
    `  - targetRoas: ${t.targetRoas.toFixed(2)}x\n` +
    `  - targetCpaMinorUnits: ${money(t.targetCpaMinorUnits, evidence.budgetOwner.currency)}`
  );
}

const INELIGIBILITY_PROSE: Record<IneligibilityReason, string> = {
  NOT_DELIVERING: "the decision unit is not currently delivering",
  ROAS_NOT_ABOVE_TARGET: "Meta ROAS is not confidently above target",
  CPA_ABOVE_TARGET: "CPA is confidently above (worse than) target",
  IN_LEARNING_PHASE:
    "the decision unit is still in Meta's learning phase — a budget change now would reset it",
  RECENT_MAJOR_CHANGE:
    "a major change (budget/creative/audience/status) happened too recently to read current performance cleanly",
};

function renderEligibilityBlock(evidence: ScalingEvidence): string {
  if (evidence.eligibleToScale) {
    return (
      `ELIGIBLE TO SCALE. Suggested change: +${evidence.suggestedChangePercent}% ` +
      `(safe range [${evidence.safeRangePercent?.[0]}%, ${evidence.safeRangePercent?.[1]}%]), ` +
      `confidence ${evidence.confidence.toFixed(2)} (a bounded heuristic on sample volume above ` +
      `the purchase floor, not a validated statistical confidence figure).`
    );
  }
  const reasons = evidence.ineligibleReasons.map((r) => `${r} (${INELIGIBILITY_PROSE[r]})`);
  return `NOT ELIGIBLE TO SCALE right now. Reasons: ${reasons.join("; ")}.`;
}

function renderCreativeFatigue(evidence: ScalingEvidence): string {
  const f = evidence.evidence.creativeFatigue;
  if (!f.applicable) return `CREATIVE FATIGUE: not applicable. ${f.note}`;
  return `CREATIVE FATIGUE: family ${f.familyId} (${f.creativeType}, ${f.variationCount ?? "?"} variation(s)). ${f.note}`;
}

function renderRecentChanges(evidence: ScalingEvidence): string {
  const c = evidence.evidence.recentChanges;
  return (
    `RECENT CHANGES: recentMajorChanges=${c.recentMajorChanges}. ` +
    `Budget changes last 7d: ${c.budgetChangesLast7Days ?? "unknown"}` +
    (c.lastBudgetChangePercent !== null ? ` (last change ${c.lastBudgetChangePercent}%)` : "") +
    `. Creative changes last 7d: ${c.creativeChangesLast7Days ?? "unknown"}. ` +
    `Hours since last audience change: ${c.hoursSinceLastAudienceChange ?? "unknown"}. ` +
    `Hours since last status change: ${c.hoursSinceLastStatusChange ?? "unknown"}.`
  );
}

function renderLearningState(evidence: ScalingEvidence): string {
  const l = evidence.evidence.learningState;
  if (l.inLearningPhase === null) return `LEARNING PHASE: not applicable at this altitude.`;
  return (
    `LEARNING PHASE: ${l.inLearningPhase ? "IN LEARNING" : "exited learning"}` +
    (l.conversionsToExitLearning !== null
      ? ` (${l.conversionsToExitLearning} conversions to exit)`
      : "") +
    (l.learningResetAt
      ? ` — last reset ${l.learningResetAt}${l.learningResetCause ? ` (${l.learningResetCause})` : ""}`
      : "") +
    "."
  );
}

/** The full EVIDENCE-outcome packet text. */
export function renderEvidencePacketText(
  evidence: ScalingEvidence,
  currentAccountDataVersion: number,
): string {
  const currency = evidence.budgetOwner.currency;
  const primary = evidence.evidence.windows[evidence.primaryWindow];
  const header =
    `DECISION PACKET — ${evidence.decisionUnit.type} ${evidence.decisionUnit.id}` +
    (evidence.decisionUnitName ? ` (${evidence.decisionUnitName})` : "") +
    `\nBuilt against accountDataVersion ${currentAccountDataVersion}. Primary window: ${evidence.primaryWindow}.`;

  const escalation = renderEscalationBlock(
    evidence.escalatedFrom,
    `${evidence.decisionUnit.type} ${evidence.decisionUnit.id}${evidence.decisionUnitName ? ` (${evidence.decisionUnitName})` : ""}`,
  );

  const windowLabels: (keyof typeof evidence.evidence.windows)[] = ["7d", "14d", "28d", "56d"];
  const windowBlocks = windowLabels
    .map((label) => evidence.evidence.windows[label])
    .filter((w): w is WindowEvidence => w !== undefined)
    .map((w) => renderWindowBlock(w.window, w, currency))
    .join("\n\n");

  const sections = [
    header,
    escalation,
    renderTargetsBlock(evidence),
    `MULTI-WINDOW PERFORMANCE (every ROAS/CPA below carries its own sample size and interval — ` +
      `never read a figure without them):\n\n${windowBlocks}`,
    renderAttributionBlock(evidence),
    primary?.seasonality.summaryText
      ? `SEASONALITY (primary window): ${primary.seasonality.summaryText}`
      : `SEASONALITY: ${evidence.evidence.seasonality.summaryText}`,
    renderLearningState(evidence),
    renderRecentChanges(evidence),
    renderCreativeFatigue(evidence),
    renderEligibilityBlock(evidence),
  ];
  return sections.filter((s) => s.length > 0).join("\n\n");
}

export function renderNotDeliveringPacketText(
  result: Extract<ScalingEvidenceResult, { outcome: "NOT_DELIVERING" }>,
  currentAccountDataVersion: number,
): string {
  const header =
    `DECISION PACKET — NOT DELIVERING.\n` +
    `Built against accountDataVersion ${currentAccountDataVersion}. Primary window: ${result.primaryWindow}.`;
  const resolvedName = `${result.decisionUnit.type} ${result.decisionUnit.id}${result.decisionUnitName ? ` (${result.decisionUnitName})` : ""}`;
  const escalation = renderEscalationBlock(result.escalatedFrom, resolvedName);
  const body =
    `You asked about ${result.namedEntity.type} ${result.namedEntity.id}. The decision unit for ` +
    `this question is ${resolvedName}.\n\n${result.detail}\n\n` +
    `No ROAS, CPA, target comparison or eligibility can be computed here — there is nothing ` +
    `currently running to measure. This is a different, more useful answer than a fabricated or ` +
    `escalated verdict would be (D1's own "not delivering, not merely low-volume" distinction).`;
  return [header, escalation, body].filter((s) => s.length > 0).join("\n\n");
}

export function renderNoDecisionUnitPacketText(
  result: Extract<ScalingEvidenceResult, { outcome: "NO_DECISION_UNIT" }>,
  currentAccountDataVersion: number,
): string {
  const header =
    `DECISION PACKET — NO DECISION UNIT.\n` +
    `Built against accountDataVersion ${currentAccountDataVersion}.`;
  const body =
    `You asked about ${result.namedEntity.type} ${result.namedEntity.id}. Budget ownership for ` +
    `this entity could not be resolved to a single decision unit.\n\n${result.detail}\n\n` +
    `Per §4.1, this system never guesses a level when ownership is genuinely ambiguous — a ` +
    `heuristic pick would look like an answer but would not actually identify who owns the ` +
    `budget being asked about. No scaling recommendation is possible until budget ownership is ` +
    `clarified (in Meta Ads Manager, or by naming a more specific entity directly).`;
  return [header, body].join("\n\n");
}

/** Dispatches on `result.outcome` — the one entry point D2's packet builder (and any caller
 * that only wants the text) needs. */
export function renderDecisionPacketText(
  result: ScalingEvidenceResult,
  currentAccountDataVersion: number,
): string {
  switch (result.outcome) {
    case "EVIDENCE":
      return renderEvidencePacketText(result.evidence, currentAccountDataVersion);
    case "NOT_DELIVERING":
      return renderNotDeliveringPacketText(result, currentAccountDataVersion);
    case "NO_DECISION_UNIT":
      return renderNoDecisionUnitPacketText(result, currentAccountDataVersion);
  }
}
