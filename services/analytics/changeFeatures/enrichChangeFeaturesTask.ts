// ENRICH_CHANGE_FEATURES — C4's own task type (not in §10.2's original list; same category of
// addition as several earlier steps' own task types, e.g. B5's SHOPIFY_IMPORT_ORDERS_CSV, B7's
// SHOPIFY_RESOLVE_ATTRIBUTION). Populates §13/§13.1's `changeAware`/`learningPhase` sub-objects
// onto the entity-feature docs C2's RECOMPUTE_FEATURES already wrote, WITHOUT touching any other
// field on those docs — see the module comment on the write step below for exactly how that
// non-collision is structural, not just a convention, so this can run safely alongside C3's own
// concurrent enrichment of the same documents' `windows[label]` interval/shrinkage/verdict
// fields.
//
// Deliberately its OWN pass over C2's already-written feature docs, per this step's own brief
// ("Implement C4 as your own enrichment pass/module... rather than restructuring C2's
// entityFeaturesBuilder.ts inline") — `entityFeaturesBuilder.ts` itself is untouched by this
// file. This does mean ENRICH_CHANGE_FEATURES must run AFTER RECOMPUTE_FEATURES in the same sync
// cycle (an entity with no feature doc yet is skipped and counted in the summary, never used to
// fabricate a partial, schema-invalid document) — the same "recompute reads what an earlier step
// already wrote" ordering B4 itself depends on relative to B2.
//
// One Firestore read pass for the whole account (matching every other C-phase task's own
// precedent): every metaCampaigns/metaAdsets/metaAds doc (for entityId + createdAt), every
// metaChangeEvents doc (grouped in memory by entity — this account's real change-event volume is
// small enough, per B4's own notes, that a full scan beats N per-entity indexed queries), and one
// bounded range query over metaInsightsDailyNormalized covering only the last
// LEARNING_PHASE_WINDOW_DAYS days (the learning-phase conversion window can never look further
// back than that — see learningPhase.ts's own module comment).

import { getDb } from "@shared/firestore/index.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { loadReportingCanon, addCalendarDays, toReportingDay } from "@shared/canon/index.ts";
import {
  changeAwareFeatures as changeAwareFeaturesSchema,
  learningPhaseFeatures as learningPhaseFeaturesSchema,
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaChangeEventSchema,
  metaInsightsDailyNormalizedSchema,
  type ChangeAwareFeatures,
  type LearningPhaseFeatures,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
  type MetaChangeEvent,
  type MetaInsightsDailyNormalized,
  type ReportingDay,
} from "@shared/schema/index.ts";
import type { FeatureEntityType } from "@services/analytics/features/index.ts";
import { mapWithConcurrency } from "@services/ingest/meta/insights/index.ts";
import type { TaskRegistration } from "@services/ingest/sync/registry.ts";
import type { TaskHandler } from "@services/ingest/sync/taskWrapper.ts";
import { computeChangeAwareFeatures } from "./changeAwareFeatures.ts";
import { computeLearningPhaseFeatures, type BudgetChangeCandidate } from "./learningPhase.ts";
import { LEARNING_PHASE_WINDOW_DAYS } from "./constants.ts";

export interface EnrichChangeFeaturesPayload {
  /** Overrides the default (yesterday, in the reporting timezone) — matches RECOMPUTE_FEATURES'
   * own default and override convention, so both tasks agree on "today" in a test without a
   * separate override each. */
  asOfDay?: ReportingDay;
  writeConcurrency?: number;
}

function parsePayload(raw: unknown): EnrichChangeFeaturesPayload {
  if (typeof raw !== "object" || raw === null) return {};
  return raw as EnrichChangeFeaturesPayload;
}

/** metaChangeEvents.entityType is CAMPAIGN|ADSET|AD only (B4/A2) — ACCOUNT and CREATIVE_FAMILY
 * are rollups with no change events of their own, so this task never processes them. */
type ChangeTrackedEntityType = "CAMPAIGN" | "ADSET" | "AD";

// Mirrors recomputeFeaturesTask.ts's own `collectionForEntityType` (A2's §8 five-vs-three
// resolution) — not imported from there since that function is private/unexported in that file,
// and this task only ever needs the AD/ADSET/CAMPAIGN branches of it.
function collectionForEntityType(entityType: ChangeTrackedEntityType): string {
  switch (entityType) {
    case "AD":
      return COLLECTIONS.adFeatures;
    case "ADSET":
    case "CAMPAIGN":
      return COLLECTIONS.adsetFeatures;
  }
}

interface EntityToProcess {
  type: FeatureEntityType & ChangeTrackedEntityType;
  id: string;
  createdAt: Date;
}

export const enrichChangeFeaturesHandler: TaskHandler = async (ctx) => {
  const payload = parsePayload(ctx.payload);
  const canon = await loadReportingCanon();
  const db = getDb();
  const computedAt = new Date();
  const writeConcurrency = payload.writeConcurrency ?? 20;

  const today = toReportingDay(computedAt, canon.reportingTimezone);
  const asOfDay = payload.asOfDay ?? addCalendarDays(today, -1);
  const purchaseLookbackStart = addCalendarDays(asOfDay, -(LEARNING_PHASE_WINDOW_DAYS - 1));

  // --- One read pass for the whole account. ---
  const [campaigns, adsets, ads] = await Promise.all([
    createRepository<MetaCampaign>(db, COLLECTIONS.metaCampaigns, metaCampaignSchema).query(
      (r) => r,
    ),
    createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema).query((r) => r),
    createRepository<MetaAd>(db, COLLECTIONS.metaAds, metaAdSchema).query((r) => r),
  ]);

  const allChangeEvents = await createRepository<MetaChangeEvent>(
    db,
    COLLECTIONS.metaChangeEvents,
    metaChangeEventSchema,
  ).query((r) => r);

  const purchaseRows = await createRepository<MetaInsightsDailyNormalized>(
    db,
    COLLECTIONS.metaInsightsDailyNormalized,
    metaInsightsDailyNormalizedSchema,
  ).query((r) =>
    r.where("reportingDay", ">=", purchaseLookbackStart).where("reportingDay", "<=", asOfDay),
  );

  // --- In-memory grouping (no per-entity queries — see module comment). ---
  const eventsByEntity = new Map<string, MetaChangeEvent[]>();
  for (const e of allChangeEvents) {
    const key = `${e.entityType}_${e.entityId}`;
    const bucket = eventsByEntity.get(key);
    if (bucket) bucket.push(e);
    else eventsByEntity.set(key, [e]);
  }

  function purchasesByDayFor(
    entityType: ChangeTrackedEntityType,
    entityId: string,
  ): Map<ReportingDay, number> {
    const out = new Map<ReportingDay, number>();
    for (const row of purchaseRows) {
      const matches =
        entityType === "AD"
          ? row.adId === entityId
          : entityType === "ADSET"
            ? row.adsetId === entityId
            : row.campaignId === entityId;
      if (!matches) continue;
      out.set(row.reportingDay, (out.get(row.reportingDay) ?? 0) + row.purchases);
    }
    return out;
  }

  const entities: EntityToProcess[] = [
    ...ads.map((a) => ({ type: "AD" as const, id: a.adId, createdAt: a.createdAt })),
    ...adsets.map((a) => ({ type: "ADSET" as const, id: a.adsetId, createdAt: a.createdAt })),
    ...campaigns.map((c) => ({
      type: "CAMPAIGN" as const,
      id: c.campaignId,
      createdAt: c.createdAt,
    })),
  ];

  let written = 0;
  let skippedNoFeatureDoc = 0;
  let changeEventsMatched = 0;
  const learningPhaseCountByType: Record<string, { inLearning: number; total: number }> = {};

  await mapWithConcurrency(entities, writeConcurrency, async (entity) => {
    const events = eventsByEntity.get(`${entity.type}_${entity.id}`) ?? [];
    changeEventsMatched += events.length;

    const changeAware: ChangeAwareFeatures = changeAwareFeaturesSchema.parse(
      computeChangeAwareFeatures({ events, asOf: computedAt }),
    );

    let learningPhase: LearningPhaseFeatures = {};
    // §13.1 talks specifically about ad sets (and, by the same Meta mechanic, individual ads) —
    // a CAMPAIGN is a rollup of many ad sets with no single learning-phase state of its own, so
    // this task deliberately never populates learningPhase for CAMPAIGN docs (changeAware still
    // is — a campaign-level budget/status edit is a real, reportable change).
    if (entity.type === "AD" || entity.type === "ADSET") {
      const budgetEvents: BudgetChangeCandidate[] = events
        .filter((e) => e.field === "BUDGET")
        .map((e) => ({
          detectedAt: e.detectedAt,
          detectedDay: toReportingDay(e.detectedAt, canon.reportingTimezone),
          percent: e.budgetChangePercent,
        }));
      const entityCreatedDay = toReportingDay(entity.createdAt, canon.reportingTimezone);
      const purchasesByDay = purchasesByDayFor(entity.type, entity.id);

      learningPhase = learningPhaseFeaturesSchema.parse(
        computeLearningPhaseFeatures({
          asOfDay,
          entityCreatedDay,
          budgetEvents,
          purchasesByDay,
        }),
      );

      const bucket = (learningPhaseCountByType[entity.type] ??= { inLearning: 0, total: 0 });
      bucket.total++;
      if (learningPhase.inLearningPhase) bucket.inLearning++;
    }

    // --- The write: a targeted top-level-field merge, never a full-document overwrite. ---
    // Deliberately NOT `repository.set()` (a full-document overwrite validated against the
    // WHOLE `entityFeaturesSchema` — would require re-supplying `windows`/`trend`/etc., which
    // this task never reads and must never clobber, especially while C3 is concurrently writing
    // interval/shrinkage/verdict fields into those same `windows[label]` objects). A raw
    // `.set({changeAware, learningPhase}, {merge: true})` on the UNCONVERTED collection ref
    // replaces only these two top-level keys and leaves every sibling top-level field (`windows`,
    // `trend`, `entityId`, `computedAt`, ...) completely untouched — a structural, not
    // conventional, non-collision with both C2's writer and C3's concurrent one, since
    // `changeAware`/`learningPhase` are C2's own explicitly-reserved-for-C4 fields (see
    // shared/schema/features.ts) that neither C2 nor C3 ever writes to.
    const collectionName = collectionForEntityType(entity.type);
    const docRef = db.collection(collectionName).doc(entity.id);
    const existing = await docRef.get();
    if (!existing.exists) {
      // No RECOMPUTE_FEATURES doc yet for this entity — see module comment on ordering. Never
      // fabricate a partial, schema-invalid doc by merging into nothing.
      skippedNoFeatureDoc++;
      return;
    }
    await docRef.set({ changeAware, learningPhase }, { merge: true });
    written++;
  });

  return {
    newRowCount: written,
    summary: {
      asOfDay,
      purchaseLookbackStart,
      entitiesConsidered: entities.length,
      written,
      skippedNoFeatureDoc,
      changeEventsRead: allChangeEvents.length,
      changeEventsMatched,
      learningPhaseCountByType,
    },
  };
};

export const enrichChangeFeaturesRegistration: TaskRegistration = {
  taskType: "ENRICH_CHANGE_FEATURES",
  runSource: "internal",
  syncStateTarget: null,
  handler: enrichChangeFeaturesHandler,
};
