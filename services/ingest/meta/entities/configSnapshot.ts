// META_SNAPSHOT_CONFIG (§9.2, §10.2) — "On every config sync, snapshot budget, status,
// targeting, bid strategy and creative assignment for every entity into metaEntitySnapshots."
//
// A self-contained live fetch, independent of META_SYNC_ENTITIES's own run (see
// fetchAll.ts's module comment for why the two task types don't share one fetch) — each
// snapshot's document id is `{entityType}_{entityId}_{syncRunId}` (`metaEntitySnapshotKey`,
// A2), so re-running this task type for the SAME run id overwrites its own partial output
// rather than accumulating duplicates, while every distinct run id (the normal case) adds a
// new, distinct point-in-time snapshot for later diffing — B4's job, out of scope here.
//
// Diffing consecutive snapshots into `metaChangeEvents` is explicitly B4's job (out of scope
// here, per this step's spec).

import { getDb } from "@shared/firestore/index.ts";
import { COLLECTIONS, collectionRef, metaEntitySnapshotKey } from "@shared/firestore/index.ts";
import { metaEntitySnapshotSchema, type MetaEntitySnapshot } from "@shared/schema/index.ts";
import { loadReportingCanon, toReportingDay } from "@shared/canon/index.ts";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import { determineAdsetBudget, determineCampaignBudgetGivenChildren } from "./budgetOwnership.ts";
import { fetchAllMetaEntities } from "./fetchAll.ts";

export const metaSnapshotConfigHandler: TaskHandler = async (ctx) => {
  const db = getDb();
  const canon = await loadReportingCanon();
  const today = toReportingDay(new Date(), canon.reportingTimezone);
  const meta = await ctx.getMetaClient();

  const fetched = await fetchAllMetaEntities(meta);

  for (const payload of fetched.campaigns.pages) {
    await ctx.archiver.archive({
      source: "meta",
      day: today,
      resource: "config_snapshot_campaigns",
      runId: ctx.runId,
      payload,
    });
  }
  for (const payload of fetched.adsets.pages) {
    await ctx.archiver.archive({
      source: "meta",
      day: today,
      resource: "config_snapshot_adsets",
      runId: ctx.runId,
      payload,
    });
  }
  for (const payload of fetched.ads.pages) {
    await ctx.archiver.archive({
      source: "meta",
      day: today,
      resource: "config_snapshot_ads",
      runId: ctx.runId,
      payload,
    });
  }

  const takenAt = new Date();

  const campaignSnapshots: MetaEntitySnapshot[] = fetched.campaigns.rows.map((raw) => ({
    entityType: "CAMPAIGN",
    entityId: raw.id,
    syncRunId: ctx.runId,
    takenAt,
    budget: determineCampaignBudgetGivenChildren(
      raw,
      fetched.adsetsByCampaignId.get(raw.id) ?? [],
      fetched.currency,
    ),
    status: raw.status,
    // Meta has no campaign-level targeting object of its own — targeting lives on the ad set.
    targeting: null,
    bidStrategy: raw.bid_strategy ?? null,
    // Meta has no campaign-level creative assignment either — creatives attach to ads.
    creativeAssignment: null,
  }));

  const campaignOwnsBudgetById = new Map(
    fetched.campaigns.rows.map((raw) => [
      raw.id,
      determineCampaignBudgetGivenChildren(
        raw,
        fetched.adsetsByCampaignId.get(raw.id) ?? [],
        fetched.currency,
      )?.ownerLevel === "CAMPAIGN",
    ]),
  );

  const adsetSnapshots: MetaEntitySnapshot[] = fetched.adsets.rows.map((raw) => ({
    entityType: "ADSET",
    entityId: raw.id,
    syncRunId: ctx.runId,
    takenAt,
    budget: determineAdsetBudget({
      adset: raw,
      campaignOwnsBudget: campaignOwnsBudgetById.get(raw.campaign_id) ?? false,
      currency: fetched.currency,
    }),
    status: raw.status,
    targeting: raw.targeting ?? null,
    bidStrategy: raw.bid_strategy ?? null,
    // Ad sets don't carry a creative assignment of their own in Meta's model either (an ad
    // set can contain many ads, each with its own creative) — left null rather than
    // fabricating an aggregate across its ads.
    creativeAssignment: null,
  }));

  const adSnapshots: MetaEntitySnapshot[] = fetched.ads.rows.map((raw) => ({
    entityType: "AD",
    entityId: raw.id,
    syncRunId: ctx.runId,
    takenAt,
    // Ads never own budget in Meta's model — matches metaAdSchema, which has no budget field.
    budget: null,
    status: raw.status,
    // Ads inherit their ad set's targeting; they have no independent targeting of their own.
    targeting: null,
    bidStrategy: null,
    creativeAssignment: raw.creative?.id ? [raw.creative.id] : [],
  }));

  const allSnapshots = [...campaignSnapshots, ...adsetSnapshots, ...adSnapshots];

  const bulkWriter = db.bulkWriter();
  const ref = collectionRef(db, COLLECTIONS.metaEntitySnapshots, metaEntitySnapshotSchema);
  for (const snapshot of allSnapshots) {
    const docId = metaEntitySnapshotKey(snapshot.entityType, snapshot.entityId, snapshot.syncRunId);
    bulkWriter.set(ref.doc(docId), snapshot);
  }
  await bulkWriter.close();

  return {
    newRowCount: allSnapshots.length,
    summary: {
      campaigns: campaignSnapshots.length,
      adsets: adsetSnapshots.length,
      ads: adSnapshots.length,
    },
  };
};

export const metaSnapshotConfigRegistration: TaskRegistration = {
  taskType: "META_SNAPSHOT_CONFIG",
  runSource: "meta",
  syncStateTarget: { source: "meta", resource: "config_snapshot" },
  handler: metaSnapshotConfigHandler,
};
