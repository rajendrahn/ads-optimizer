// META_SYNC_ENTITIES (§10.2) — campaigns, ad sets, ads, creatives normalized into Firestore.
//
// Meta is the single source of truth for *current* config state: every successful run
// replaces each collection's docs wholesale, keyed directly by Meta's own IDs (no version
// guard — see shared/schema/meta.ts's module comment for why that's the right call here,
// unlike Shopify/insights, whose writes can arrive out of order). Raw pages are archived
// verbatim, before normalization, for replay per §23.
//
// Deliberately has no `newWatermarkDate`: unlike insights/orders, a full entity sync has no
// natural "furthest date of data collected" — every run re-fetches the *current* state of
// everything, not an incremental window. `syncState/meta_entities` still gets
// `lastSuccessfulSyncAt`/`status`/`lastRunId` updated on every success (useful health
// signal), just with `lastDataDate` staying null.

import { getDb } from "@shared/firestore/index.ts";
import { COLLECTIONS, collectionRef } from "@shared/firestore/index.ts";
import {
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
} from "@shared/schema/index.ts";
import { loadReportingCanon, toReportingDay } from "@shared/canon/index.ts";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import { fetchAllMetaEntities } from "./fetchAll.ts";
import { normalizeAd, normalizeAdset, normalizeCampaign, normalizeCreative } from "./normalize.ts";

export const metaSyncEntitiesHandler: TaskHandler = async (ctx) => {
  const db = getDb();
  const canon = await loadReportingCanon();
  const today = toReportingDay(new Date(), canon.reportingTimezone);
  const meta = await ctx.getMetaClient();
  const accountId = canon.accountId;

  const fetched = await fetchAllMetaEntities(meta);

  for (const payload of fetched.campaigns.pages) {
    await ctx.archiver.archive({
      source: "meta",
      day: today,
      resource: "campaigns",
      runId: ctx.runId,
      payload,
    });
  }
  for (const payload of fetched.adsets.pages) {
    await ctx.archiver.archive({
      source: "meta",
      day: today,
      resource: "adsets",
      runId: ctx.runId,
      payload,
    });
  }
  for (const payload of fetched.ads.pages) {
    await ctx.archiver.archive({
      source: "meta",
      day: today,
      resource: "ads",
      runId: ctx.runId,
      payload,
    });
  }
  for (const payload of fetched.creatives.pages) {
    await ctx.archiver.archive({
      source: "meta",
      day: today,
      resource: "creatives",
      runId: ctx.runId,
      payload,
    });
  }

  const syncedAt = new Date();
  const normalizeCtx = { accountId, currency: fetched.currency, syncedAt };

  const normalizedCampaigns = fetched.campaigns.rows.map((raw) =>
    normalizeCampaign(raw, fetched.adsetsByCampaignId.get(raw.id) ?? [], normalizeCtx),
  );
  const campaignOwnsBudgetById = new Map(
    normalizedCampaigns.map((c) => [c.campaignId, c.budget?.ownerLevel === "CAMPAIGN"]),
  );
  const normalizedAdsets = fetched.adsets.rows.map((raw) =>
    normalizeAdset(raw, campaignOwnsBudgetById.get(raw.campaign_id) ?? false, normalizeCtx),
  );
  const normalizedCreatives = fetched.creatives.rows.map((raw) =>
    normalizeCreative(raw, { accountId, syncedAt }),
  );
  const creativeLinkUrlById = new Map(normalizedCreatives.map((c) => [c.creativeId, c.linkUrl]));
  const normalizedAds = fetched.ads.rows.map((raw) =>
    normalizeAd(raw, { accountId, syncedAt, creativeLinkUrlById }),
  );

  // Wholesale replace via a BulkWriter — efficient batched writes for the ~2,000+ documents a
  // full sync produces on this account (410 campaigns / 534 ad sets / 1,139+ ads live), still
  // schema-validated on the way in via each collection's typed, converter-wrapped ref.
  const bulkWriter = db.bulkWriter();
  const campaignsRef = collectionRef(db, COLLECTIONS.metaCampaigns, metaCampaignSchema);
  for (const doc of normalizedCampaigns) bulkWriter.set(campaignsRef.doc(doc.campaignId), doc);
  const adsetsRef = collectionRef(db, COLLECTIONS.metaAdsets, metaAdsetSchema);
  for (const doc of normalizedAdsets) bulkWriter.set(adsetsRef.doc(doc.adsetId), doc);
  const adsRef = collectionRef(db, COLLECTIONS.metaAds, metaAdSchema);
  for (const doc of normalizedAds) bulkWriter.set(adsRef.doc(doc.adId), doc);
  const creativesRef = collectionRef(db, COLLECTIONS.metaCreatives, metaCreativeSchema);
  for (const doc of normalizedCreatives) bulkWriter.set(creativesRef.doc(doc.creativeId), doc);
  await bulkWriter.close();

  return {
    newRowCount:
      normalizedCampaigns.length +
      normalizedAdsets.length +
      normalizedAds.length +
      normalizedCreatives.length,
    summary: {
      campaigns: normalizedCampaigns.length,
      adsets: normalizedAdsets.length,
      ads: normalizedAds.length,
      creatives: normalizedCreatives.length,
    },
  };
};

export const metaSyncEntitiesRegistration: TaskRegistration = {
  taskType: "META_SYNC_ENTITIES",
  runSource: "meta",
  syncStateTarget: { source: "meta", resource: "entities" },
  handler: metaSyncEntitiesHandler,
};
