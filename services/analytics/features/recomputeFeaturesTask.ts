// RECOMPUTE_FEATURES — §10.2's own name, already in `taskTypes.ts`'s SYNC_TASK_TYPES list (no
// new task type needed, unlike several earlier steps). §10.1: "Full recompute replaces
// affected-entity propagation... Recompute ALL entity features... Bump accountDataVersion (one
// write per sync run)." This handler is a Firestore-to-Firestore re-derivation over C1's
// normalized collections (`metaInsightsDailyNormalized`, `shopifyOrdersNormalized`,
// `shopifyRefundsNormalized`, `shopifyDailyCoverage`) plus B2/B8's already-synced entity/creative
// collections — it makes no live Meta or Shopify call, and has no watermark of its own
// (`runSource: "internal"`, `syncStateTarget: null`), matching C1's own two tasks' precedent
// exactly.
//
// One Firestore read pass for the whole account, reused across every entity/window computed —
// NOT one query per entity. The widest window (56d) plus the previous-7d trend baseline both fit
// inside a single 56-day-back lookback from `asOfDay` (previousEquivalentWindow(7d window) never
// reaches further back than the 56d window's own start — see the module comment on
// entityFeaturesBuilder.ts's `computeOneWindow` for the exact math), so exactly one range query
// per source collection covers everything every entity/window needs.
//
// `asOfDay` defaults to YESTERDAY (in the reporting timezone), not today: Meta/Shopify data for
// the current, still-in-progress calendar day is necessarily partial, and a full recompute that
// includes a partial "today" in its 7d/28d windows would understate every metric it touches by
// however much of today hasn't happened yet — indistinguishable, without this default, from a
// real drop. Overridable via payload (tests, or a future intraday-recompute use case) — a
// documented assumption, not a hardcoded fact about how syncs are scheduled.

import { getDb } from "@shared/firestore/index.ts";
import { COLLECTIONS, createRepository, upsertWithVersionGuard } from "@shared/firestore/index.ts";
import { loadReportingCanon, addCalendarDays, toReportingDay } from "@shared/canon/index.ts";
import {
  accountFeaturesSchema,
  adFeaturesSchema,
  adsetFeaturesSchema,
  adUrlTagAuditSchema,
  creativeAssetSchema,
  creativeFamilyFeaturesSchema,
  creativeFamilySchema,
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
  metaInsightsDailyNormalizedSchema,
  shopifyDailyCoverageSchema,
  shopifyOrderNormalizedSchema,
  shopifyRefundNormalizedSchema,
  type AdUrlTagAudit,
  type CreativeAsset,
  type CreativeFamily,
  type EntityFeatures,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
  type MetaCreative,
  type MetaInsightsDailyNormalized,
  type ReportingDay,
  type ShopifyDailyCoverage,
  type ShopifyOrderNormalized,
  type ShopifyRefundNormalized,
} from "@shared/schema/index.ts";
import { mapWithConcurrency } from "@services/ingest/meta/insights/index.ts";
import type { TaskRegistration } from "@services/ingest/sync/registry.ts";
import type { TaskHandler } from "@services/ingest/sync/taskWrapper.ts";
import { readNextAccountDataVersion } from "./accountDataVersion.ts";
import { buildOrderAttributionIndex } from "./attribution.ts";
import { buildEntityFeatures, type FeatureComputationContext } from "./entityFeaturesBuilder.ts";
import { buildEntityGraph } from "./entityGraph.ts";
import type { FeatureEntityType } from "./attribution.ts";
import type { SeasonalityContextProvider } from "./seasonality.ts";
// C5 has landed, so the real provider is wired in as the production default below. This is the
// single point of coupling between C2 and C5; everything else in this directory still depends
// only on the injected contract in seasonality.ts, exactly as it was built to.
import { seasonalityContextFor } from "../seasonality/index.ts";
import { WINDOW_LENGTH_DAYS } from "./windows.ts";

export interface RecomputeFeaturesPayload {
  /** Overrides the default (yesterday, in the reporting timezone) — see module comment. */
  asOfDay?: ReportingDay;
  writeConcurrency?: number;
  /** Injected per C5's contract — see seasonality.ts's module comment. **Test-only in practice:**
   * this payload is JSON-serialized over Cloud Tasks, so a function set here never survives the
   * trip. Production uses the real C5 provider wired as the default at the call site below; a
   * test can still inject a fake here without needing the real calendar. */
  seasonalityProvider?: SeasonalityContextProvider;
}

function parsePayload(raw: unknown): RecomputeFeaturesPayload {
  if (typeof raw !== "object" || raw === null) return {};
  return raw as RecomputeFeaturesPayload;
}

// Every `*FeaturesSchema` export used below is literally `entityFeaturesSchema` (see
// shared/schema/features.ts) — all four collections share one document shape, so `typeof
// adFeaturesSchema` names that one shape for all of them.
function collectionForEntityType(entityType: FeatureEntityType): {
  name: string;
  schema: typeof adFeaturesSchema;
} {
  switch (entityType) {
    case "AD":
      return { name: COLLECTIONS.adFeatures, schema: adFeaturesSchema };
    case "ADSET":
    case "CAMPAIGN":
      // A2's own suggested resolution for the §8 five-vs-three-collections ambiguity: campaign
      // features live in adsetFeatures, keyed by campaign id, entityType "CAMPAIGN".
      return { name: COLLECTIONS.adsetFeatures, schema: adsetFeaturesSchema };
    case "CREATIVE_FAMILY":
      return { name: COLLECTIONS.creativeFamilyFeatures, schema: creativeFamilyFeaturesSchema };
    case "ACCOUNT":
      return { name: COLLECTIONS.accountFeatures, schema: accountFeaturesSchema };
  }
}

export const recomputeFeaturesHandler: TaskHandler = async (ctx) => {
  const payload = parsePayload(ctx.payload);
  const canon = await loadReportingCanon();
  const db = getDb();
  const computedAt = new Date();
  const writeConcurrency = payload.writeConcurrency ?? 20;

  const today = toReportingDay(computedAt, canon.reportingTimezone);
  const asOfDay = payload.asOfDay ?? addCalendarDays(today, -1);
  const earliestDay = addCalendarDays(asOfDay, -(WINDOW_LENGTH_DAYS["56d"] - 1));

  // --- One read pass for the whole account. ---
  const [campaigns, adsets, ads, creatives, assets, families] = await Promise.all([
    createRepository<MetaCampaign>(db, COLLECTIONS.metaCampaigns, metaCampaignSchema).query(
      (r) => r,
    ),
    createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema).query((r) => r),
    createRepository<MetaAd>(db, COLLECTIONS.metaAds, metaAdSchema).query((r) => r),
    createRepository<MetaCreative>(db, COLLECTIONS.metaCreatives, metaCreativeSchema).query(
      (r) => r,
    ),
    createRepository<CreativeAsset>(db, COLLECTIONS.creativeAssets, creativeAssetSchema).query(
      (r) => r,
    ),
    createRepository<CreativeFamily>(db, COLLECTIONS.creativeFamilies, creativeFamilySchema).query(
      (r) => r,
    ),
  ]);

  const metaRepo = createRepository<MetaInsightsDailyNormalized>(
    db,
    COLLECTIONS.metaInsightsDailyNormalized,
    metaInsightsDailyNormalizedSchema,
  );
  const ordersRepo = createRepository<ShopifyOrderNormalized>(
    db,
    COLLECTIONS.shopifyOrdersNormalized,
    shopifyOrderNormalizedSchema,
  );
  const refundsRepo = createRepository<ShopifyRefundNormalized>(
    db,
    COLLECTIONS.shopifyRefundsNormalized,
    shopifyRefundNormalizedSchema,
  );
  const coverageRepo = createRepository<ShopifyDailyCoverage>(
    db,
    COLLECTIONS.shopifyDailyCoverage,
    shopifyDailyCoverageSchema,
  );
  const auditRepo = createRepository<AdUrlTagAudit>(
    db,
    COLLECTIONS.adUrlTagAudits,
    adUrlTagAuditSchema,
  );

  const [metaRows, orders, refunds, coverageRows, unresolvableAudits] = await Promise.all([
    metaRepo.query((r) =>
      r.where("reportingDay", ">=", earliestDay).where("reportingDay", "<=", asOfDay),
    ),
    ordersRepo.query((r) =>
      r.where("reportingDay", ">=", earliestDay).where("reportingDay", "<=", asOfDay),
    ),
    refundsRepo.query((r) =>
      r.where("reportingDay", ">=", earliestDay).where("reportingDay", "<=", asOfDay),
    ),
    coverageRepo.query((r) =>
      r.where("reportingDay", ">=", earliestDay).where("reportingDay", "<=", asOfDay),
    ),
    auditRepo.query((r) => r.where("resolvable", "==", false)),
  ]);

  const graph = buildEntityGraph({ ads, adsets, campaigns, creatives, assets, families });
  const coverageByDay = new Map(coverageRows.map((c) => [c.reportingDay, c]));
  const unresolvableAdIds = new Set(unresolvableAudits.map((a) => a.adId));
  const orderAttributionIndex = buildOrderAttributionIndex(orders);
  const accountDataVersion = await readNextAccountDataVersion(db, canon.accountId);

  const featureCtx: FeatureComputationContext = {
    reportingCurrency: canon.reportingCurrency,
    accountId: canon.accountId,
    accountDataVersion,
    computedAt,
    graph,
    allMetaRows: metaRows,
    allShopifyOrders: orders,
    allShopifyRefunds: refunds,
    coverageByDay,
    orderAttributionIndex,
    unresolvableAdIds,
    // Defaults to C5's real provider. This must be a default rather than something the payload
    // supplies, because `payload` arrives as JSON over Cloud Tasks and a function cannot survive
    // that serialization — `payload.seasonalityProvider` is therefore ALWAYS undefined in
    // production and only ever set by a test calling this handler directly. Without this default
    // the seam would silently never engage in the one environment that matters, and every window
    // would carry NULL_SEASONALITY_CONTEXT while looking correctly wired.
    seasonalityProvider: payload.seasonalityProvider ?? seasonalityContextFor,
  };

  const entities: { type: FeatureEntityType; id: string }[] = [
    ...ads.map((a) => ({ type: "AD" as const, id: a.adId })),
    ...adsets.map((a) => ({ type: "ADSET" as const, id: a.adsetId })),
    ...campaigns.map((c) => ({ type: "CAMPAIGN" as const, id: c.campaignId })),
    ...families.map((f) => ({ type: "CREATIVE_FAMILY" as const, id: f.familyId })),
    { type: "ACCOUNT" as const, id: canon.accountId },
  ];

  let written = 0;
  let rejected = 0;
  const countsByType: Record<string, number> = {};

  await mapWithConcurrency(entities, writeConcurrency, async ({ type, id }) => {
    const features: EntityFeatures = await buildEntityFeatures(type, id, asOfDay, featureCtx);
    const { name, schema } = collectionForEntityType(type);
    const outcome = await upsertWithVersionGuard({
      db,
      collectionName: name,
      docId: id,
      incoming: features,
      schema,
      getUpdatedAt: (doc) => doc.computedAt,
      onRejected: ctx.recordVersionGuardRejection,
    });
    if (outcome.action === "written") written++;
    else rejected++;
    countsByType[type] = (countsByType[type] ?? 0) + 1;
  });

  return {
    newRowCount: written,
    summary: {
      asOfDay,
      earliestDay,
      accountDataVersion,
      entitiesComputed: entities.length,
      written,
      rejected,
      countsByType,
      metaRowsRead: metaRows.length,
      shopifyOrdersRead: orders.length,
      shopifyRefundsRead: refunds.length,
      coverageDaysRead: coverageRows.length,
      unresolvableAdCount: unresolvableAdIds.size,
    },
  };
};

export const recomputeFeaturesRegistration: TaskRegistration = {
  taskType: "RECOMPUTE_FEATURES",
  runSource: "internal",
  syncStateTarget: null,
  handler: recomputeFeaturesHandler,
};
