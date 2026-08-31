// COMPUTE_STATISTICS — C3's own enrichment pass over C2's already-written feature documents.
//
// Architecture note (why this is a SEPARATE task/pass rather than folded into C2's
// entityFeaturesBuilder.ts, per this step's explicit brief): shrinkage toward the account mean
// structurally requires knowing the account's own mean ROAS for a window before any individual
// entity in that window can be shrunk. RECOMPUTE_FEATURES (C2) computes every entity's raw
// figures — including the ACCOUNT-level rollup — in one pass, entity-by-entity, with no ordering
// guarantee that the account doc is ever fully known before some other entity is processed. This
// task runs strictly AFTER a RECOMPUTE_FEATURES run has finished (reading its output collections,
// never its raw source collections), so the account-level doc is guaranteed complete before any
// shrinkage math happens.
//
// Collision safety with C4 (running concurrently, enriching `changeAware`/`learningPhase` on the
// SAME documents): this task NEVER does a full-document `set()`/`upsertWithVersionGuard` write —
// see `writeStatisticsPatch` below. It writes only `windows.{label}.{purchases,metaRoas,
// metaRoasShrunk,shopifyRoas,shopifyRoasShrunk,cpa}` via a recursive-merge partial `set(...,
// {merge:true})`, which Firestore resolves at the LEAF field-path level — `changeAware`,
// `learningPhase`, and every other field on the same window object (spend, ctr, seasonality,
// shopifyDataGap, ...) are untouched no matter which of C3/C4 writes first or last. This is a
// commutative field-level write, not a document-level one — the two passes cannot clobber each
// other regardless of ordering.
//
// Staleness guard: a document is only written if a fresh read, taken inside the same transaction
// as the write, still shows the `accountDataVersion` this task computed its statistics against —
// otherwise the write is skipped (a concurrent RECOMPUTE_FEATURES run has since superseded the
// values this task read, and the next COMPUTE_STATISTICS run will pick up the newer version).

import { z } from "zod";
import type { Firestore } from "firebase-admin/firestore";
import { getDb, COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { loadReportingCanon, resolveStatisticalThresholds } from "@shared/canon/index.ts";
import {
  accountFeaturesSchema,
  adFeaturesSchema,
  adsetFeaturesSchema,
  creativeFamilyFeaturesSchema,
  metricWithInterval,
  type EntityFeatures,
  type WindowLabel,
} from "@shared/schema/index.ts";
import { mapWithConcurrency } from "@services/ingest/meta/insights/index.ts";
import { ALL_WINDOW_LABELS } from "@services/analytics/features/index.ts";
import type { TaskRegistration } from "@services/ingest/sync/registry.ts";
import type { TaskHandler } from "@services/ingest/sync/taskWrapper.ts";
import {
  computeWindowStatistics,
  type AccountMeansForWindow,
  type WindowStatisticsPatch,
} from "./windowStatistics.ts";

export interface ComputeStatisticsPayload {
  writeConcurrency?: number;
}

function parsePayload(raw: unknown): ComputeStatisticsPayload {
  if (typeof raw !== "object" || raw === null) return {};
  return raw as ComputeStatisticsPayload;
}

// Validates the shape actually written per window before it ever reaches Firestore — this task
// bypasses the typed repository's full-document `set()` (deliberately — see module comment), so
// this is the one place a malformed patch would otherwise go undetected. Built from the SAME
// `metricWithInterval` schema C2's own windows use, `.omit()`-ing the two fields this task never
// touches (`value`, `sampleSize` — both stay exactly as C2 wrote them).
const metricStatOnlySchema = metricWithInterval.omit({ value: true, sampleSize: true });
const windowStatisticsWriteSchema = z.object({
  purchases: z.object({
    intervalLow: z.number().finite().nullable(),
    intervalHigh: z.number().finite().nullable(),
  }),
  metaRoas: metricStatOnlySchema,
  metaRoasShrunk: z.number().finite().nullable(),
  shopifyRoas: metricStatOnlySchema,
  shopifyRoasShrunk: z.number().finite().nullable(),
  cpa: metricStatOnlySchema,
});

/** `null` is a legitimate finite value here (schema is `.nullable()`); Firestore itself rejects
 * `Infinity`/`NaN` outright, so a non-finite number is sanitised to `null` (with a warning) rather
 * than allowed to reach the write and fail the whole entity — see interval.ts's own defensive
 * floor for why this should be unreachable in practice, not a normal code path. */
function finiteOrNull(x: number | null): number | null {
  if (x === null) return null;
  if (!Number.isFinite(x)) {
    console.warn(
      "[computeStatistics] non-finite value produced by the estimator — storing null",
      x,
    );
    return null;
  }
  return x;
}

function toWritePatch(stats: WindowStatisticsPatch): z.infer<typeof windowStatisticsWriteSchema> {
  const patch = {
    purchases: {
      intervalLow: finiteOrNull(stats.purchasesInterval.intervalLow),
      intervalHigh: finiteOrNull(stats.purchasesInterval.intervalHigh),
    },
    metaRoas: {
      intervalLow: finiteOrNull(stats.metaRoas.intervalLow),
      intervalHigh: finiteOrNull(stats.metaRoas.intervalHigh),
      verdict: stats.metaRoas.verdict,
    },
    metaRoasShrunk: finiteOrNull(stats.metaRoasShrunk),
    shopifyRoas: {
      intervalLow: finiteOrNull(stats.shopifyRoas.intervalLow),
      intervalHigh: finiteOrNull(stats.shopifyRoas.intervalHigh),
      verdict: stats.shopifyRoas.verdict,
    },
    shopifyRoasShrunk: finiteOrNull(stats.shopifyRoasShrunk),
    cpa: {
      intervalLow: finiteOrNull(stats.cpa.intervalLow),
      intervalHigh: finiteOrNull(stats.cpa.intervalHigh),
      verdict: stats.cpa.verdict,
    },
  };
  return windowStatisticsWriteSchema.parse(patch);
}

interface EntityDocRef {
  collectionName: string;
  doc: EntityFeatures;
}

async function writeStatisticsPatch(
  db: Firestore,
  collectionName: string,
  entityId: string,
  targetVersion: number,
  patchWindows: Partial<Record<WindowLabel, z.infer<typeof windowStatisticsWriteSchema>>>,
): Promise<"written" | "skipped-stale" | "skipped-missing"> {
  const ref = db.collection(collectionName).doc(entityId);
  return db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists) return "skipped-missing";
    const freshVersion = (fresh.data() as { accountDataVersion?: number } | undefined)
      ?.accountDataVersion;
    if (freshVersion !== targetVersion) return "skipped-stale";
    // Recursive-merge partial write — see module comment. Only the leaf field paths present in
    // `patchWindows` are touched; every sibling field (changeAware, learningPhase, every other
    // window metric) is left exactly as it was.
    tx.set(ref, { windows: patchWindows }, { merge: true });
    return "written";
  });
}

export const computeStatisticsHandler: TaskHandler = async (ctx) => {
  const payload = parsePayload(ctx.payload);
  const canon = await loadReportingCanon();
  const thresholdsCfg = resolveStatisticalThresholds(canon);
  const db = getDb();
  const writeConcurrency = payload.writeConcurrency ?? 20;

  const accountRepo = createRepository<EntityFeatures>(
    db,
    COLLECTIONS.accountFeatures,
    accountFeaturesSchema,
  );
  const accountDoc = await accountRepo.get(canon.accountId);
  if (!accountDoc) {
    throw new Error(
      "COMPUTE_STATISTICS: no accountFeatures/{accountId} doc exists yet — run RECOMPUTE_FEATURES " +
        "first (C3 needs the account-level mean before it can shrink any individual entity).",
    );
  }
  const targetVersion = accountDoc.accountDataVersion;

  const accountMeansByWindow = {} as Record<WindowLabel, AccountMeansForWindow>;
  for (const label of ALL_WINDOW_LABELS) {
    const w = accountDoc.windows[label];
    accountMeansByWindow[label] = {
      metaRoas: w?.metaRoas?.value ?? null,
      shopifyRoas: w?.shopifyRoas?.value ?? null,
    };
  }

  const [ads, adsets, families] = await Promise.all([
    createRepository<EntityFeatures>(db, COLLECTIONS.adFeatures, adFeaturesSchema).query((r) => r),
    createRepository<EntityFeatures>(db, COLLECTIONS.adsetFeatures, adsetFeaturesSchema).query(
      (r) => r,
    ),
    createRepository<EntityFeatures>(
      db,
      COLLECTIONS.creativeFamilyFeatures,
      creativeFamilyFeaturesSchema,
    ).query((r) => r),
  ]);

  const allDocs: EntityDocRef[] = [
    ...ads.map((doc) => ({ collectionName: COLLECTIONS.adFeatures, doc })),
    ...adsets.map((doc) => ({ collectionName: COLLECTIONS.adsetFeatures, doc })),
    ...families.map((doc) => ({ collectionName: COLLECTIONS.creativeFamilyFeatures, doc })),
    { collectionName: COLLECTIONS.accountFeatures, doc: accountDoc },
  ];

  let written = 0;
  let skippedStale = 0;
  let skippedMissing = 0;
  let skippedWrongVersion = 0;

  await mapWithConcurrency(allDocs, writeConcurrency, async ({ collectionName, doc }) => {
    // A doc still on an older accountDataVersion is mid-way through (or hasn't yet been reached
    // by) the RECOMPUTE_FEATURES run this task is enriching — not ready for this pass yet. It
    // will be picked up on the next COMPUTE_STATISTICS run, once RECOMPUTE_FEATURES has caught it
    // up to the target version too.
    if (doc.accountDataVersion !== targetVersion) {
      skippedWrongVersion++;
      return;
    }

    const patchWindows: Partial<Record<WindowLabel, z.infer<typeof windowStatisticsWriteSchema>>> =
      {};
    for (const label of ALL_WINDOW_LABELS) {
      const window = doc.windows[label];
      if (!window) continue;
      const stats = computeWindowStatistics(window, accountMeansByWindow[label], {
        minPurchaseFloor: thresholdsCfg.minPurchaseFloors[label] ?? 0,
        targetRoas: thresholdsCfg.targetRoas,
        targetCpaMinorUnits: thresholdsCfg.targetCpaMinorUnits,
        intervalZScore: thresholdsCfg.intervalZScore,
      });
      patchWindows[label] = toWritePatch(stats);
    }
    if (Object.keys(patchWindows).length === 0) return;

    const outcome = await writeStatisticsPatch(
      db,
      collectionName,
      doc.entityId,
      targetVersion,
      patchWindows,
    );
    if (outcome === "written") written++;
    else if (outcome === "skipped-stale") skippedStale++;
    else skippedMissing++;
  });

  return {
    newRowCount: written,
    summary: {
      accountDataVersion: targetVersion,
      entitiesConsidered: allDocs.length,
      written,
      skippedStale,
      skippedMissing,
      skippedWrongVersion,
    },
  };
};

export const computeStatisticsRegistration: TaskRegistration = {
  taskType: "COMPUTE_STATISTICS",
  runSource: "internal",
  syncStateTarget: null,
  handler: computeStatisticsHandler,
};
