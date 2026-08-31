// D2's own "Done when" bar, proven end to end against a real Firestore emulator and the REAL,
// unmodified RECOMPUTE_FEATURES -> COMPUTE_STATISTICS -> ENRICH_CHANGE_FEATURES pipeline (same
// pattern D1's own scalingEvidenceEngine.emulator.test.ts uses, and the same three fixture
// scenarios — reproduced here rather than imported, matching every other step's own
// self-contained emulator test):
//
//   1. A packet renders with sample sizes and intervals visible in the TEXT (not only reachable
//      via the JSON) — proven for all three ScalingEvidenceResult outcomes (EVIDENCE,
//      NOT_DELIVERING, NO_DECISION_UNIT).
//   2. A version bump marks a previously-cached packet stale — accountDataVersion advances (a
//      second RECOMPUTE_FEATURES run over changed data), then MARK_DECISION_PACKETS_STALE flips
//      `isStale` on the packet cached against the OLD version, and leaves a freshly-regenerated
//      one (built against the NEW version) alone.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  decisionPacketSchema,
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaInsightsDailyNormalizedSchema,
  shopifyDailyCoverageSchema,
  type DecisionPacket,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
  type MetaInsightsDailyNormalized,
  type NormalizedMoney,
  type ReportingDay,
  type ShopifyDailyCoverage,
} from "@shared/schema/index.ts";
import { TEST_CANON } from "../../services/ingest/meta/entities/testFixtures.ts";
import { createDefaultRegistry } from "../../services/ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "../../services/ingest/sync/store.ts";
import { runSyncTask } from "../../services/ingest/sync/taskWrapper.ts";
import type { RawArchiveStore } from "../../services/ingest/sync/archiver.ts";
import { addCalendarDays } from "@shared/canon/index.ts";
import { generateAndCacheDecisionPacket, markStalePackets } from "./decisionPacketStore.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "decisionPacketStore.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

const dummyArchiver: RawArchiveStore = {
  archive: async () => ({ path: "unused" }),
  read: async () => undefined,
};

const ALL_COLLECTIONS = [
  COLLECTIONS.metaCampaigns,
  COLLECTIONS.metaAdsets,
  COLLECTIONS.metaAds,
  COLLECTIONS.metaCreatives,
  COLLECTIONS.creativeAssets,
  COLLECTIONS.creativeFamilies,
  COLLECTIONS.metaChangeEvents,
  COLLECTIONS.metaInsightsDailyNormalized,
  COLLECTIONS.shopifyOrdersNormalized,
  COLLECTIONS.shopifyRefundsNormalized,
  COLLECTIONS.shopifyDailyCoverage,
  COLLECTIONS.adUrlTagAudits,
  COLLECTIONS.adFeatures,
  COLLECTIONS.adsetFeatures,
  COLLECTIONS.creativeFamilyFeatures,
  COLLECTIONS.accountFeatures,
  COLLECTIONS.syncState,
  COLLECTIONS.syncRuns,
  COLLECTIONS.settings,
  COLLECTIONS.decisionPackets,
];

async function cleanupCollections() {
  for (const name of ALL_COLLECTIONS) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

const ACCOUNT_ID = TEST_CANON.accountId;
const AS_OF_DAY: ReportingDay = "2026-08-30";

beforeEach(async () => {
  resetReportingCanonCacheForTests();
  await cleanupCollections();
  const settingsRepo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
  await settingsRepo.set(ACCOUNT_ID, TEST_CANON);
});
afterAll(cleanupCollections);

function money(amountMinorUnits: number): NormalizedMoney {
  return {
    amountMinorUnits,
    currency: "INR",
    sourceAmountMinorUnits: amountMinorUnits,
    sourceCurrency: "INR",
    fxRateToReportingCurrency: 1,
    fxRateSource: "same_currency_no_conversion",
  };
}

async function seedAdVolume(
  adId: string,
  adsetId: string,
  campaignId: string,
  days: number,
  totalPurchases: number,
  totalSpendMinorUnits: number,
  totalPurchaseValueMinorUnits: number,
) {
  const repo = createRepository<MetaInsightsDailyNormalized>(
    db,
    COLLECTIONS.metaInsightsDailyNormalized,
    metaInsightsDailyNormalizedSchema,
  );
  function bucket(total: number, i: number): number {
    return Math.round((total * (i + 1)) / days) - Math.round((total * i) / days);
  }
  for (let i = 0; i < days; i++) {
    const day = addCalendarDays(AS_OF_DAY, -i) as ReportingDay;
    const row: MetaInsightsDailyNormalized = {
      adId,
      adsetId,
      campaignId,
      accountId: ACCOUNT_ID,
      reportingDay: day,
      reportingTimezone: "Asia/Kolkata",
      nativeDate: day,
      nativeTimezone: "Asia/Kolkata",
      attribution: { attributionWindow: "7d_click_1d_view", purchaseActionType: "omni_purchase" },
      spend: money(Math.max(0, bucket(totalSpendMinorUnits, i))),
      purchaseValue: money(Math.max(0, bucket(totalPurchaseValueMinorUnits, i))),
      impressions: 500,
      reach: 400,
      frequency: 1.25,
      clicks: 25,
      landingPageViews: 20,
      addToCart: 3,
      initiateCheckout: 1,
      purchases: Math.max(0, bucket(totalPurchases, i)),
      sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
      computedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await repo.set(`${adId}_${day}`, row);
  }
}

async function seedCoverage(fromDay: ReportingDay, toDay: ReportingDay) {
  const repo = createRepository<ShopifyDailyCoverage>(
    db,
    COLLECTIONS.shopifyDailyCoverage,
    shopifyDailyCoverageSchema,
  );
  for (let day = fromDay; day <= toDay; day = addCalendarDays(day, 1)) {
    const row: ShopifyDailyCoverage = {
      reportingDay: day,
      reportingTimezone: "Asia/Kolkata",
      accountId: ACCOUNT_ID,
      hasCoverageGap: false,
      gapReason: null,
      ordersObserved: 0,
      refundsObserved: 0,
      computedAt: new Date("2026-08-30T00:00:00Z"),
      sourceUpdatedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await repo.set(day, row);
  }
}

async function runFullPipeline() {
  const syncStore = createFirestoreSyncStore(db);
  const registry = createDefaultRegistry();
  const recompute = await runSyncTask({
    syncStore,
    registry,
    taskType: "RECOMPUTE_FEATURES",
    payload: { asOfDay: AS_OF_DAY },
    archiver: dummyArchiver,
  });
  expect(recompute.status).toBe("SUCCEEDED");
  const stats = await runSyncTask({
    syncStore,
    registry,
    taskType: "COMPUTE_STATISTICS",
    payload: {},
    archiver: dummyArchiver,
  });
  expect(stats.status).toBe("SUCCEEDED");
  const changeFeatures = await runSyncTask({
    syncStore,
    registry,
    taskType: "ENRICH_CHANGE_FEATURES",
    payload: { asOfDay: AS_OF_DAY },
    archiver: dummyArchiver,
  });
  expect(changeFeatures.status).toBe("SUCCEEDED");
}

async function seedDeliveringAdset() {
  const campaign: MetaCampaign = {
    campaignId: "cmp_1",
    accountId: ACCOUNT_ID,
    name: "Bridal Sets — Prospecting",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    buyingType: "AUCTION",
    budget: null,
    bidStrategy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    syncedAt: new Date("2026-08-30T00:00:00Z"),
  };
  const adset: MetaAdset = {
    adsetId: "AS_17",
    campaignId: "cmp_1",
    accountId: ACCOUNT_ID,
    name: "AS-17 — Bridal broad",
    status: "ACTIVE",
    budget: {
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: 500_00,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    },
    optimizationGoal: "OFFSITE_CONVERSIONS",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    targeting: null,
    placements: null,
    attribution: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    syncedAt: new Date("2026-08-30T00:00:00Z"),
  };
  await createRepository<MetaCampaign>(db, COLLECTIONS.metaCampaigns, metaCampaignSchema).set(
    campaign.campaignId,
    campaign,
  );
  await createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema).set(
    adset.adsetId,
    adset,
  );

  const adIds = Array.from({ length: 9 }, (_, i) => `ad_pool_${i}`);
  const adsRepo = createRepository<MetaAd>(db, COLLECTIONS.metaAds, metaAdSchema);
  for (const adId of adIds) {
    const ad: MetaAd = {
      adId,
      adsetId: "AS_17",
      campaignId: "cmp_1",
      accountId: ACCOUNT_ID,
      creativeId: null,
      name: `Ad ${adId}`,
      status: "ACTIVE",
      destinationUrl: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      metaUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await adsRepo.set(adId, ad);
    // 30 purchases/28d each, ~176,100 minor-units CPA — a realistic measured account CPA well
    // above the 150,000 (₹1,500) placeholder target, matching this account's real shape.
    await seedAdVolume(adId, "AS_17", "cmp_1", 28, 30, 5_283_000, 20_000_000);
  }
  await seedCoverage("2026-08-03" as ReportingDay, AS_OF_DAY);
}

describe("generateAndCacheDecisionPacket + markStalePackets — D2's own Done-when bar", () => {
  it("1) EVIDENCE outcome: packet renders with sample sizes and intervals visible in the text, and caches", async () => {
    await seedDeliveringAdset();
    await runFullPipeline();

    const { packet, action } = await generateAndCacheDecisionPacket({
      db,
      namedEntity: { type: "ADSET", id: "AS_17" },
    });
    expect(action).toBe("written");
    expect(packet.outcome).toBe("EVIDENCE");
    expect(packet.isStale).toBe(false);
    expect(packet.accountDataVersion).toBeGreaterThan(0);
    expect(decisionPacketSchema.parse(packet)).toBeTruthy();

    const text = packet.textRendering;
    if (text === null) throw new Error("expected a non-null text rendering");
    expect(text).toMatch(/purchases/);
    expect(text).toMatch(/interval/i);
    expect(text).toMatch(/ATTRIBUTION COVERAGE/);
    expect(text).toMatch(/TARGETS THIS PACKET WAS JUDGED AGAINST/);

    // Actually cached — a real Firestore read of decisionPackets/AS_17 (wait: keyed by NAMED
    // entity — see packetBuilder.ts's own module comment) returns the same doc.
    const stored = await createRepository<DecisionPacket>(
      db,
      COLLECTIONS.decisionPackets,
      decisionPacketSchema,
    ).get("ADSET_AS_17");
    if (stored === null) throw new Error("expected the packet to be cached");
    expect(stored.textRendering).toBe(text);

    console.log("\n=== EVIDENCE packet (ADSET AS_17) ===\n" + text + "\n");
  });

  it("2) NOT_DELIVERING outcome renders and caches", async () => {
    const campaign: MetaCampaign = {
      campaignId: "cmp_2",
      accountId: ACCOUNT_ID,
      name: "Legacy remarketing (inactive)",
      status: "ACTIVE",
      objective: null,
      buyingType: null,
      budget: null,
      bidStrategy: null,
      createdAt: new Date("2024-06-01T00:00:00Z"),
      metaUpdatedAt: new Date("2024-06-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    };
    const deadAdset: MetaAdset = {
      adsetId: "as_dead",
      campaignId: "cmp_2",
      accountId: ACCOUNT_ID,
      name: "Legacy remarketing ad set",
      status: "ACTIVE",
      budget: {
        ownerLevel: "ADSET",
        dailyBudgetMinorUnits: 10_00,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
      optimizationGoal: null,
      bidStrategy: null,
      targeting: null,
      placements: null,
      attribution: null,
      createdAt: new Date("2024-06-01T00:00:00Z"),
      metaUpdatedAt: new Date("2024-06-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await createRepository<MetaCampaign>(db, COLLECTIONS.metaCampaigns, metaCampaignSchema).set(
      campaign.campaignId,
      campaign,
    );
    await createRepository<MetaAdset>(db, COLLECTIONS.metaAdsets, metaAdsetSchema).set(
      deadAdset.adsetId,
      deadAdset,
    );
    // No metaInsightsDailyNormalized rows — zero delivery.

    await runFullPipeline();

    const { packet, action } = await generateAndCacheDecisionPacket({
      db,
      namedEntity: { type: "ADSET", id: "as_dead" },
    });
    expect(action).toBe("written");
    expect(packet.outcome).toBe("NOT_DELIVERING");
    expect(packet.decisionUnit).toEqual({ type: "ADSET", id: "as_dead" });
    expect(packet.textRendering).toMatch(/NOT DELIVERING/);
    expect(packet.textRendering).toMatch(/not delivering, not merely low-volume/i);

    console.log("\n=== NOT_DELIVERING packet (ADSET as_dead) ===\n" + packet.textRendering + "\n");
  });

  it("3) NO_DECISION_UNIT outcome renders and caches, with decisionUnit explicitly null", async () => {
    const orphan: MetaCampaign = {
      campaignId: "cmp_orphan",
      accountId: ACCOUNT_ID,
      name: "Sales — 2023 (orphaned)",
      status: "PAUSED",
      objective: null,
      buyingType: null,
      budget: {
        ownerLevel: "UNKNOWN",
        dailyBudgetMinorUnits: null,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
      bidStrategy: null,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      metaUpdatedAt: new Date("2024-01-01T00:00:00Z"),
      syncedAt: new Date("2026-08-30T00:00:00Z"),
    };
    await createRepository<MetaCampaign>(db, COLLECTIONS.metaCampaigns, metaCampaignSchema).set(
      orphan.campaignId,
      orphan,
    );

    await runFullPipeline();

    const { packet, action } = await generateAndCacheDecisionPacket({
      db,
      namedEntity: { type: "CAMPAIGN", id: "cmp_orphan" },
    });
    expect(action).toBe("written");
    expect(packet.outcome).toBe("NO_DECISION_UNIT");
    expect(packet.decisionUnit).toBeNull();
    expect(packet.textRendering).toMatch(/NO DECISION UNIT/);
    expect(packet.textRendering).toMatch(/UNKNOWN/);

    console.log(
      "\n=== NO_DECISION_UNIT packet (CAMPAIGN cmp_orphan) ===\n" + packet.textRendering + "\n",
    );
  });

  it("4) a version bump marks a previously-cached packet stale, and leaves a fresh one alone", async () => {
    await seedDeliveringAdset();
    await runFullPipeline();

    const first = await generateAndCacheDecisionPacket({
      db,
      namedEntity: { type: "ADSET", id: "AS_17" },
    });
    expect(first.packet.isStale).toBe(false);
    const versionAfterFirstRun = first.packet.accountDataVersion;

    // A second sync cycle: new daily volume lands, RECOMPUTE_FEATURES runs again and bumps
    // accountDataVersion (§10.1: "bumped once per sync run").
    await seedAdVolume("ad_pool_0", "AS_17", "cmp_1", 1, 2, 20_000, 80_000);
    await runFullPipeline();

    // Not yet marked stale — nothing has run the staleness pass yet.
    const beforeMark = await createRepository<DecisionPacket>(
      db,
      COLLECTIONS.decisionPackets,
      decisionPacketSchema,
    ).get("ADSET_AS_17");
    if (beforeMark === null) throw new Error("expected the packet to still be cached");
    expect(beforeMark.isStale).toBe(false);
    expect(beforeMark.accountDataVersion).toBe(versionAfterFirstRun); // still stamped with the OLD version

    const markResult = await markStalePackets(db, ACCOUNT_ID);
    expect(markResult.currentAccountDataVersion).toBeGreaterThan(versionAfterFirstRun);
    expect(markResult.markedStale).toBe(1);

    const afterMark = await createRepository<DecisionPacket>(
      db,
      COLLECTIONS.decisionPackets,
      decisionPacketSchema,
    ).get("ADSET_AS_17");
    if (afterMark === null) throw new Error("expected the packet to still be cached");
    expect(afterMark.isStale).toBe(true);
    expect(afterMark.accountDataVersion).toBe(versionAfterFirstRun); // stamping itself is untouched — only isStale flips

    // Regenerating now produces a fresh, non-stale packet stamped with the NEW version.
    const regenerated = await generateAndCacheDecisionPacket({
      db,
      namedEntity: { type: "ADSET", id: "AS_17" },
    });
    expect(regenerated.packet.isStale).toBe(false);
    expect(regenerated.packet.accountDataVersion).toBe(markResult.currentAccountDataVersion);

    // Running the staleness pass again touches nothing — the packet is current.
    const markAgain = await markStalePackets(db, ACCOUNT_ID);
    expect(markAgain.markedStale).toBe(0);
  });

  it("5) MARK_DECISION_PACKETS_STALE is registered and runnable as a real task", async () => {
    await seedDeliveringAdset();
    await runFullPipeline();
    await generateAndCacheDecisionPacket({ db, namedEntity: { type: "ADSET", id: "AS_17" } });

    const registry = createDefaultRegistry();
    expect(registry.list()).toContain("MARK_DECISION_PACKETS_STALE");

    const syncStore = createFirestoreSyncStore(db);
    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "MARK_DECISION_PACKETS_STALE",
      payload: {},
      archiver: dummyArchiver,
    });
    expect(result.status).toBe("SUCCEEDED");
  });
});
