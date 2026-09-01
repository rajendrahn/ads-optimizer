// E1's orchestrator: for one "as of" reporting day T, reconstructs point-in-time Meta insights
// evidence (using ONLY data whose producing sync run had completed by T — see
// pointInTimeArchive.ts), generates both strategies' recommendations, reconstructs the ACTUAL
// post-T outcome from the full archive, scores each, and writes both results to `backtestRuns`
// (§21.2, §8).
//
// Data-gap handling (B5/C1's real Shopify hole, [2025-12-14, ~2026-07-02)): the decision itself
// never depends on Shopify data (see evidence.ts/strategies.ts — Meta-attributed metaRoas/cpa
// only), so a gap window cannot masquerade as a revenue collapse in either strategy's DECISION.
// The account-level blended MER this function also reports as CONTEXT (never as a gating input)
// carries its own `windowHasDataGap` flag, computed from the same `shopifyDailyCoverage` logic
// C1/C2 use — a gap-affected blended MER is reported AS gap-affected, never silently.
//
// Seasonality (C5): `seasonalityProvider`, when supplied, is threaded straight through to
// evidence.ts exactly the way C2 injects it (the same `SeasonalityContextProvider` contract) —
// `spansSeasonalBoundary` then participates in C3's own `computeWindowStatistics` suppression
// rule (a window whose comparison baseline sits in a different seasonal regime never yields a
// confident verdict), so a Diwali-vs-off-season backtest window is flagged, never de-seasonalised
// or silently scored as if the underlying metric were direction-comparable.

import { randomUUID } from "node:crypto";
import { createRepository } from "@shared/firestore/index.ts";
import {
  addCalendarDays,
  reportingDayToUtcRange,
  type CanonSettings,
} from "@shared/canon/index.ts";
import { resolveStatisticalThresholds } from "@shared/canon/index.ts";
import {
  allWindowsEnding,
  type SeasonalityContextProvider,
  type WindowLabel,
} from "@services/analytics/features/index.ts";
import type { BacktestRun, ReportingDay, SyncStateKnownGap } from "@shared/schema/index.ts";
import { backtestRunSchema } from "@shared/schema/index.ts";
import { COLLECTIONS } from "@shared/firestore/collections.ts";
import type { Firestore } from "firebase-admin/firestore";
import type { ArchiveListable, SyncRunSource } from "./pointInTimeArchive.ts";
import { PointInTimeArchiveReader } from "./pointInTimeArchive.ts";
import { reconstructMetaInsightsNormalizedAsOf } from "./reconstructMeta.ts";
import { reconstructShopifyNormalizedAsOf } from "./reconstructShopify.ts";
import {
  buildAdSetWindowEvidence,
  computeAccountMetaMeans,
  groupMetaRowsByAdset,
  type AdSetWindowEvidence,
} from "./evidence.ts";
import {
  decideNaiveHighestRecentRoas,
  decideSystemStrategy,
  type BacktestRecommendation,
} from "./strategies.ts";
import { computeActualOutcome, computeBrierScoreComponent, type ActualOutcome } from "./outcome.ts";
import type { RawArchiveStore } from "@services/ingest/sync/archiver.ts";

/** JSON-round-trips a value to strip any nested `undefined` before it reaches Firestore — the
 * exact defensive move D2's own notes describe needing after a real (not unit-tested-only)
 * `undefined` write failure: "invisible to zod's z.record()... invisible to every unit test...
 * only shows up against a real emulator." Every field this module constructs is already set to
 * an explicit `null` rather than left `undefined`, but this costs nothing and removes the same
 * class of bug by construction rather than by discipline. */
function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface RunBacktestInput {
  db: Firestore;
  archive: RawArchiveStore;
  listable: ArchiveListable;
  syncRuns: SyncRunSource;
  canon: CanonSettings;
  /** T — the reporting day this backtest replays a decision as of. */
  asOfDate: ReportingDay;
  primaryWindow?: WindowLabel;
  /** The window "recent ROAS" means for the naive strategy. Default "7d". */
  recentWindow?: WindowLabel;
  /** How many days after T the actual-outcome window covers. Default 28 (one primary window's
   * worth of post-decision evidence). */
  horizonDays?: number;
  /** Fixed change percent the naive strategy always proposes — see strategies.ts's own module
   * comment for why this is not guardrail-clamped. Default 20. */
  naiveChangePercent?: number;
  /** B5's own recorded Shopify `knownGaps` — used ONLY for the account-level blended-MER context
   * this function reports alongside (never inside) the decision. `[]` for a synthetic proof with
   * no gap. */
  knownGaps: readonly SyncStateKnownGap[];
  seasonalityProvider?: SeasonalityContextProvider;
}

export interface RunBacktestResult {
  asOfDate: ReportingDay;
  system: {
    recommendation: BacktestRecommendation;
    outcome: ActualOutcome;
    brierScoreComponent: number | null;
    backtestRunId: string;
  };
  naive: {
    recommendation: BacktestRecommendation;
    outcome: ActualOutcome;
    brierScoreComponent: number | null;
    backtestRunId: string;
  };
  /** Account-level blended-MER CONTEXT for the primary window — reported, never used to gate
   * either strategy's decision (§6.3: "uses no attribution at all", the honest account-level
   * read at this account's ~0.02% per-entity attribution coverage, B7). */
  blendedMerContext: { value: number | null; windowHasDataGap: boolean; gapDays: string[] };
}

async function buildEvidenceList(
  reader: PointInTimeArchiveReader,
  window: { startDay: ReportingDay; endDay: ReportingDay },
  canon: CanonSettings,
  seasonalityProvider: SeasonalityContextProvider | undefined,
): Promise<{
  list: AdSetWindowEvidence[];
  allRows: Awaited<ReturnType<typeof reconstructMetaInsightsNormalizedAsOf>>;
}> {
  const allRows = await reconstructMetaInsightsNormalizedAsOf(reader, {
    accountId: canon.accountId,
    currency: canon.reportingCurrency,
    attribution: {
      attributionWindow: canon.attributionWindow,
      purchaseActionType: canon.purchaseActionType,
    },
    reportingTimezone: canon.reportingTimezone,
    reportingCurrency: canon.reportingCurrency,
    nativeTimezone: canon.reportingTimezone,
  });

  const byAdset = groupMetaRowsByAdset(allRows);
  const accountMeans = computeAccountMetaMeans(allRows, window, canon.reportingCurrency);
  const thresholds = resolveStatisticalThresholds(canon);
  const primaryLabel: WindowLabel = "28d";

  let seasonality;
  if (seasonalityProvider) {
    try {
      seasonality = await seasonalityProvider(window);
    } catch {
      seasonality = undefined;
    }
  }

  const list: AdSetWindowEvidence[] = [];
  for (const [adsetId, rows] of byAdset) {
    list.push(
      buildAdSetWindowEvidence({
        adsetId,
        rows,
        window,
        reportingCurrency: canon.reportingCurrency,
        accountMeans,
        thresholds: {
          minPurchaseFloor: thresholds.minPurchaseFloors[primaryLabel],
          targetRoas: thresholds.targetRoas,
          targetCpaMinorUnits: thresholds.targetCpaMinorUnits,
          intervalZScore: thresholds.intervalZScore,
        },
        seasonality,
      }),
    );
  }
  return { list, allRows };
}

export async function runBacktestForDate(input: RunBacktestInput): Promise<RunBacktestResult> {
  const primaryLabel = input.primaryWindow ?? "28d";
  const recentLabel = input.recentWindow ?? "7d";
  const horizonDays = input.horizonDays ?? 28;
  const naiveChangePercent = input.naiveChangePercent ?? 20;
  const canon = input.canon;
  const thresholds = resolveStatisticalThresholds(canon);

  // ---- Decision side: only data known by end-of-day T. ----
  const asOfInstant = reportingDayToUtcRange(
    input.asOfDate,
    canon.reportingTimezone,
  ).endUtcExclusive;
  const decisionReader = await PointInTimeArchiveReader.create({
    asOfInstant,
    archive: input.archive,
    listable: input.listable,
    syncRuns: input.syncRuns,
  });

  const windows = allWindowsEnding(input.asOfDate);
  const primaryWindow = windows[primaryLabel];
  const recentWindow = windows[recentLabel];

  const { list: primaryEvidence } = await buildEvidenceList(
    decisionReader,
    primaryWindow,
    canon,
    input.seasonalityProvider,
  );
  const { list: recentEvidence } = await buildEvidenceList(
    decisionReader,
    recentWindow,
    canon,
    input.seasonalityProvider,
  );

  const systemRec = decideSystemStrategy(
    primaryEvidence,
    canon,
    thresholds.minPurchaseFloors[primaryLabel],
  );
  const naiveRec = decideNaiveHighestRecentRoas(recentEvidence, naiveChangePercent);

  // ---- Ground truth side: everything archived through T + horizonDays. No leakage constraint
  // applies here by definition (see module comment) — this is what we score the decision
  // against, not an input to it. ----
  const horizonEndDay = addCalendarDays(input.asOfDate, horizonDays);
  const horizonInstant = reportingDayToUtcRange(
    horizonEndDay,
    canon.reportingTimezone,
  ).endUtcExclusive;
  const outcomeReader = await PointInTimeArchiveReader.create({
    asOfInstant: horizonInstant,
    archive: input.archive,
    listable: input.listable,
    syncRuns: input.syncRuns,
  });
  const horizonWindow = {
    startDay: addCalendarDays(input.asOfDate, 1),
    endDay: horizonEndDay,
  };
  const fullRowsThroughHorizon = await reconstructMetaInsightsNormalizedAsOf(outcomeReader, {
    accountId: canon.accountId,
    currency: canon.reportingCurrency,
    attribution: {
      attributionWindow: canon.attributionWindow,
      purchaseActionType: canon.purchaseActionType,
    },
    reportingTimezone: canon.reportingTimezone,
    reportingCurrency: canon.reportingCurrency,
    nativeTimezone: canon.reportingTimezone,
  });

  const systemOutcome = computeActualOutcome(
    systemRec,
    fullRowsThroughHorizon,
    horizonWindow,
    canon.reportingCurrency,
    thresholds.targetRoas,
    thresholds.intervalZScore,
    thresholds.minPurchaseFloors[primaryLabel],
  );
  const naiveOutcome = computeActualOutcome(
    naiveRec,
    fullRowsThroughHorizon,
    horizonWindow,
    canon.reportingCurrency,
    thresholds.targetRoas,
    thresholds.intervalZScore,
    thresholds.minPurchaseFloors[primaryLabel],
  );

  const systemBrier = computeBrierScoreComponent(systemRec, systemOutcome);
  const naiveBrier = computeBrierScoreComponent(naiveRec, naiveOutcome);

  // ---- Account-level blended-MER context (Shopify side), decision-time reader — reported, not
  // gating. ----
  const shopifyState = await reconstructShopifyNormalizedAsOf(decisionReader, {
    reportingTimezone: canon.reportingTimezone,
    reportingCurrency: canon.reportingCurrency,
    accountId: canon.accountId,
    knownGaps: input.knownGaps,
    fromDay: primaryWindow.startDay,
    toDay: primaryWindow.endDay,
  });
  const primaryMetaTotalsAllAdsets = (
    await buildEvidenceList(decisionReader, primaryWindow, canon, undefined)
  ).allRows.filter(
    (r) => r.reportingDay >= primaryWindow.startDay && r.reportingDay <= primaryWindow.endDay,
  );
  const totalSpend = primaryMetaTotalsAllAdsets.reduce((s, r) => s + r.spend.amountMinorUnits, 0);
  const windowOrders = shopifyState.orders.filter(
    (o) => o.reportingDay >= primaryWindow.startDay && o.reportingDay <= primaryWindow.endDay,
  );
  const windowRefunds = shopifyState.refunds.filter(
    (r) => r.reportingDay >= primaryWindow.startDay && r.reportingDay <= primaryWindow.endDay,
  );
  const grossRevenue = windowOrders.reduce((s, o) => s + o.totalPrice.amountMinorUnits, 0);
  const refundsTotal = windowRefunds.reduce((s, r) => s + r.amount.amountMinorUnits, 0);
  const netRevenue = grossRevenue - refundsTotal;
  const blendedMerValue = totalSpend === 0 ? null : netRevenue / totalSpend;
  const gapDays: string[] = [];
  for (const day of Array.from(shopifyState.coverageByDay.keys())) {
    if (day < primaryWindow.startDay || day > primaryWindow.endDay) continue;
    if (shopifyState.coverageByDay.get(day)?.hasCoverageGap) gapDays.push(day);
  }

  // ---- Persist both strategies' backtestRuns docs (emulator only — see this step's safety
  // constraints; the real entry point is the caller's responsibility to point at the right
  // Firestore instance). ----
  const repo = createRepository(input.db, COLLECTIONS.backtestRuns, backtestRunSchema);
  const createdAt = new Date();

  const systemRunId = `bt_SYSTEM_${input.asOfDate}_${randomUUID()}`;
  const systemRun: BacktestRun = {
    backtestRunId: systemRunId,
    asOfDate: input.asOfDate,
    strategy: "SYSTEM",
    decisionUnit: systemRec.decisionUnit,
    generatedRecommendation: jsonSafe(systemRec),
    actualOutcome: jsonSafe(systemOutcome),
    brierScoreComponent: systemBrier,
    createdAt,
  };
  await repo.set(systemRunId, systemRun);

  const naiveRunId = `bt_NAIVE_${input.asOfDate}_${randomUUID()}`;
  const naiveRun: BacktestRun = {
    backtestRunId: naiveRunId,
    asOfDate: input.asOfDate,
    strategy: "NAIVE_HIGHEST_RECENT_ROAS",
    decisionUnit: naiveRec.decisionUnit,
    generatedRecommendation: jsonSafe(naiveRec),
    actualOutcome: jsonSafe(naiveOutcome),
    brierScoreComponent: naiveBrier,
    createdAt,
  };
  await repo.set(naiveRunId, naiveRun);

  return {
    asOfDate: input.asOfDate,
    system: {
      recommendation: systemRec,
      outcome: systemOutcome,
      brierScoreComponent: systemBrier,
      backtestRunId: systemRunId,
    },
    naive: {
      recommendation: naiveRec,
      outcome: naiveOutcome,
      brierScoreComponent: naiveBrier,
      backtestRunId: naiveRunId,
    },
    blendedMerContext: { value: blendedMerValue, windowHasDataGap: gapDays.length > 0, gapDays },
  };
}
