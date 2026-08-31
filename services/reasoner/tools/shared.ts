// Small helpers shared by several tools in this directory — kept out of types.ts because these
// are implementation details of a handful of tools, not part of the §18 tool-shape contract.

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  accountFeaturesSchema,
  type EntityFeatures,
  type VerdictReasonCode,
} from "@shared/schema/index.ts";
import { explainVerdict } from "@services/evidence/index.ts";
import { formatMinorUnitsAsDecimal } from "@shared/canon/index.ts";
import type { Verdict } from "@services/analytics/statistics/index.ts";

/** Mirrors `services/evidence/evidenceAssembler.ts`'s own (private) `metricSnapshot` helper —
 * same shape, same `explainVerdict` call, reimplemented here rather than exported from D1/D2's
 * module because D1 keeps that helper private to `evidenceAssembler.ts` and this step must not
 * edit files owned by the concurrent agent working in `services/analytics/statistics/` and
 * `services/evidence/verdictExplain.ts`. `explainVerdict` itself IS part of the public evidence
 * barrel (`services/evidence/index.ts`) and is used here read-only, unmodified — including its
 * current `verdictReasonCode`-based shape (D1's own orchestrator-note fix: the reason a verdict
 * was suppressed is now STORED by C3, not re-derived here). */
export interface RawMetricLike {
  value: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  sampleSize: number;
  verdict: Verdict | null;
  verdictReasonCode?: VerdictReasonCode | null;
}

export interface MetricSnapshotOut {
  value: number | null;
  interval: [number | null, number | null];
  purchases: number;
  verdict: Verdict | null;
  verdictReason: string;
}

export function metricSnapshot(
  label: string,
  metric: RawMetricLike | undefined,
  target: number,
  minPurchaseFloor: number,
  seasonality: { labels: readonly string[] } | undefined,
  gapDays?: readonly string[],
  formatValue?: (value: number) => string,
): MetricSnapshotOut {
  const m = metric ?? {
    value: null,
    intervalLow: null,
    intervalHigh: null,
    sampleSize: 0,
    verdict: null,
    verdictReasonCode: null,
  };
  return {
    value: m.value,
    interval: [m.intervalLow, m.intervalHigh],
    purchases: m.sampleSize,
    verdict: m.verdict,
    verdictReason: explainVerdict({
      label,
      value: m.value,
      verdict: m.verdict,
      intervalLow: m.intervalLow,
      intervalHigh: m.intervalHigh,
      sampleSize: m.sampleSize,
      minPurchaseFloor,
      target,
      verdictReasonCode: m.verdictReasonCode,
      seasonalityLabels: seasonality?.labels ?? [],
      gapDays,
      formatValue,
    }),
  };
}

export function moneySnapshot(
  label: string,
  metric: RawMetricLike | undefined,
  targetMinorUnits: number,
  minPurchaseFloor: number,
  seasonality: { labels: readonly string[] } | undefined,
  currency: string,
): MetricSnapshotOut {
  return metricSnapshot(
    label,
    metric,
    targetMinorUnits,
    minPurchaseFloor,
    seasonality,
    undefined,
    (value) => formatMinorUnitsAsDecimal({ amountMinorUnits: Math.round(value), currency }),
  );
}

function featuresCollectionFor(entityType: "AD" | "ADSET" | "CAMPAIGN"): string {
  return entityType === "AD" ? COLLECTIONS.adFeatures : COLLECTIONS.adsetFeatures;
}

export async function loadFeaturesFor(
  db: Firestore,
  entityType: "AD" | "ADSET" | "CAMPAIGN",
  entityId: string,
): Promise<EntityFeatures | null> {
  const repo = createRepository<EntityFeatures>(
    db,
    featuresCollectionFor(entityType),
    accountFeaturesSchema, // same shape as ad/adset/account features — see shared/schema/features.ts
  );
  return repo.get(entityId);
}

export async function loadAccountFeatures(
  db: Firestore,
  accountId: string,
): Promise<EntityFeatures | null> {
  const repo = createRepository<EntityFeatures>(
    db,
    COLLECTIONS.accountFeatures,
    accountFeaturesSchema,
  );
  return repo.get(accountId);
}
