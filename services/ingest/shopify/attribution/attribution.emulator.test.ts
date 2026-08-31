// Emulator-backed proof of B7's "Done when" bar: "Orders resolve to ads on real data; an
// untagged ad appears in the audit output; the coverage ratio computes and is stored." Every
// Firestore call here is real, against the emulator — no live Meta/Shopify call (this step's
// join and audit are both Firestore-to-Firestore, reading what B2/B5 already ingested).

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, createRepository, syncStateKey } from "@shared/firestore/index.ts";
import {
  adUrlTagAuditSchema,
  metaAdSchema,
  metaCampaignSchema,
  shopifyOrderSchema,
  type MetaAd,
  type MetaCampaign,
  type ShopifyOrder,
} from "@shared/schema/index.ts";
import type { RawArchiveStore } from "../../sync/archiver.ts";
import { createTaskRegistry } from "../../sync/registry.ts";
import { createFirestoreSyncStore } from "../../sync/store.ts";
import { runSyncTask } from "../../sync/taskWrapper.ts";
import { auditAdUrlTagsRegistration } from "./urlAudit.ts";
import { shopifyResolveAttributionRegistration } from "./resolveAttribution.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "attribution.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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

async function cleanupCollections() {
  for (const name of [
    COLLECTIONS.metaCampaigns,
    COLLECTIONS.metaAds,
    COLLECTIONS.shopifyOrders,
    COLLECTIONS.adUrlTagAudits,
    COLLECTIONS.syncState,
    COLLECTIONS.syncRuns,
  ]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

beforeEach(cleanupCollections);
afterAll(cleanupCollections);

const NOW = new Date("2026-08-31T00:00:00Z");

const campaign: MetaCampaign = {
  campaignId: "120210000000001",
  accountId: "act_test",
  name: "New Sales Ad Set",
  status: "ACTIVE",
  objective: "OUTCOME_SALES",
  buyingType: "AUCTION",
  budget: null,
  bidStrategy: null,
  createdAt: NOW,
  metaUpdatedAt: NOW,
  syncedAt: NOW,
};

const adResolvable: MetaAd = {
  adId: "120210000000003",
  adsetId: "as_1",
  campaignId: campaign.campaignId,
  accountId: "act_test",
  creativeId: null,
  name: "RM_Instagram",
  status: "ACTIVE",
  destinationUrl: "https://sparkleandglow.co.in/products/x?utm_source=meta&utm_content={{ad.id}}",
  createdAt: NOW,
  metaUpdatedAt: NOW,
  syncedAt: NOW,
};

/** A live ad whose destination URL carries only a static human name, not a macro — Open
 * Question #1's dominant real-account case. Should be flagged by the audit as unresolvable. */
const adUnresolvable: MetaAd = {
  ...adResolvable,
  adId: "120210000000004",
  name: "Navratri sale 15% OFF| AD",
  destinationUrl:
    "https://sparkleandglow.co.in/products/y?utm_source=meta&utm_content=Navratri%20sale%2015%25%20OFF%7C%20AD",
};

const adDeleted: MetaAd = {
  ...adResolvable,
  adId: "120210000000005",
  status: "DELETED",
  destinationUrl: null, // irrelevant — a deleted ad is excluded from the audit regardless
};

async function seedMetaEntities() {
  const campaignsRepo = createRepository(db, COLLECTIONS.metaCampaigns, metaCampaignSchema);
  const adsRepo = createRepository(db, COLLECTIONS.metaAds, metaAdSchema);
  await campaignsRepo.set(campaign.campaignId, campaign);
  await adsRepo.set(adResolvable.adId, adResolvable);
  await adsRepo.set(adUnresolvable.adId, adUnresolvable);
  await adsRepo.set(adDeleted.adId, adDeleted);
}

function baseOrder(overrides: Partial<ShopifyOrder>): ShopifyOrder {
  return {
    orderId: "ord_1",
    orderNumber: "#1001",
    createdAt: NOW,
    sourceUpdatedAt: NOW,
    currency: "INR",
    totalPriceMinorUnits: 299900,
    subtotalPriceMinorUnits: 279900,
    totalDiscountsMinorUnits: 0,
    totalShippingMinorUnits: null,
    financialStatus: "paid",
    fulfillmentStatus: null,
    cancelledAt: null,
    customerId: "cust_1",
    isNewCustomer: true,
    country: "IN",
    landingSite: null,
    referringSite: null,
    rawAttributionTag: null,
    resolvedAdId: null,
    resolvedCampaignId: null,
    resolutionMethod: null,
    resolutionConfidence: null,
    source: "MATRIXIFY_IMPORT",
    syncedAt: NOW,
    ...overrides,
  };
}

describe("SHOPIFY_RESOLVE_ATTRIBUTION — real join against Firestore-backed Meta entities", () => {
  it("resolves an AD_ID order, a NAME_MATCH order, and leaves an untagged order UNRESOLVED (never zero)", async () => {
    await seedMetaEntities();
    const ordersRepo = createRepository(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);

    const orderAdId = baseOrder({
      orderId: "ord_ad_id",
      landingSite: "/products/x?utm_source=meta&utm_content=120210000000003",
    });
    const orderNameMatch = baseOrder({
      orderId: "ord_name_match",
      landingSite:
        "/products/y?utm_source=roi_meta&utm_content=Navratri%20sale%2015%25%20OFF%7C%20AD",
    });
    const orderUntagged = baseOrder({ orderId: "ord_untagged", landingSite: null });
    const orderFbclidOnly = baseOrder({
      orderId: "ord_fbclid_only",
      landingSite: "/products/z?fbclid=IwAR123abc",
    });

    await Promise.all(
      [orderAdId, orderNameMatch, orderUntagged, orderFbclidOnly].map((o) =>
        ordersRepo.set(o.orderId, o),
      ),
    );

    const registry = createTaskRegistry();
    registry.register(shopifyResolveAttributionRegistration);
    const syncStore = createFirestoreSyncStore(db);

    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "SHOPIFY_RESOLVE_ATTRIBUTION",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run_resolve_1",
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.summary).toMatchObject({
      resolvedByAdId: 1,
      resolvedByNameMatch: 1,
      unresolved: 2, // untagged + fbclid-only
    });

    const written = await ordersRepo.get("ord_ad_id");
    expect(written?.resolutionMethod).toBe("AD_ID");
    expect(written?.resolvedAdId).toBe(adResolvable.adId);
    expect(written?.resolvedCampaignId).toBe(campaign.campaignId);
    expect(written?.resolutionConfidence).toBe(1);

    const writtenName = await ordersRepo.get("ord_name_match");
    expect(writtenName?.resolutionMethod).toBe("NAME_MATCH");
    expect(writtenName?.resolvedAdId).toBe(adUnresolvable.adId);
    expect(writtenName?.resolutionConfidence).toBeLessThan(1);

    // The untagged order must NEVER be written as if it resolved to zero for any ad — it must
    // simply carry UNRESOLVED with both resolved ids left null.
    const writtenUntagged = await ordersRepo.get("ord_untagged");
    expect(writtenUntagged?.resolutionMethod).toBe("UNRESOLVED");
    expect(writtenUntagged?.resolvedAdId).toBeNull();
    expect(writtenUntagged?.resolvedCampaignId).toBeNull();

    const writtenFbclid = await ordersRepo.get("ord_fbclid_only");
    expect(writtenFbclid?.resolutionMethod).toBe("UNRESOLVED");
    expect(writtenFbclid?.rawAttributionTag).toBe("fbclid=IwAR123abc");
  });

  it("re-running is idempotent — an equal-version write is accepted, no duplicate/changed count on the second pass", async () => {
    await seedMetaEntities();
    const ordersRepo = createRepository(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
    await ordersRepo.set(
      "ord_1",
      baseOrder({
        orderId: "ord_1",
        landingSite: "/products/x?utm_source=meta&utm_content=120210000000003",
      }),
    );

    const registry = createTaskRegistry();
    registry.register(shopifyResolveAttributionRegistration);
    const syncStore = createFirestoreSyncStore(db);

    const first = await runSyncTask({
      syncStore,
      registry,
      taskType: "SHOPIFY_RESOLVE_ATTRIBUTION",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run_a",
    });
    expect(first.summary?.["resolvedByAdId"]).toBe(1);

    const second = await runSyncTask({
      syncStore,
      registry,
      taskType: "SHOPIFY_RESOLVE_ATTRIBUTION",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run_b",
    });
    // Same result, nothing "changed" the second time (already resolved identically).
    expect(second.summary).toMatchObject({ changed: 0, resolvedByAdId: 1 });
  });
});

describe("AUDIT_AD_URL_TAGS — real join against Firestore-backed metaAds", () => {
  it("flags the unresolvable live ad, skips the deleted one, and persists per-ad audit docs", async () => {
    await seedMetaEntities();

    const registry = createTaskRegistry();
    registry.register(auditAdUrlTagsRegistration);
    const syncStore = createFirestoreSyncStore(db);

    const result = await runSyncTask({
      syncStore,
      registry,
      taskType: "AUDIT_AD_URL_TAGS",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run_audit_1",
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.summary).toMatchObject({
      adsAudited: 2, // adResolvable + adUnresolvable — adDeleted excluded
      adsSkippedNotLive: 1,
      resolvable: 1,
      unresolvable: 1,
    });

    const auditRepo = createRepository(db, COLLECTIONS.adUrlTagAudits, adUrlTagAuditSchema);
    const resolvableAudit = await auditRepo.get(adResolvable.adId);
    expect(resolvableAudit?.tagKind).toBe("ID_MACRO");
    expect(resolvableAudit?.resolvable).toBe(true);

    const unresolvableAudit = await auditRepo.get(adUnresolvable.adId);
    expect(unresolvableAudit?.tagKind).toBe("STATIC_TEXT");
    expect(unresolvableAudit?.resolvable).toBe(false);

    // The deleted ad was never audited at all — no doc written for it.
    const deletedAudit = await auditRepo.get(adDeleted.adId);
    expect(deletedAudit).toBeNull();
  });

  it("advances syncRuns but never touches syncState — this task type has no watermark", async () => {
    await seedMetaEntities();
    const registry = createTaskRegistry();
    registry.register(auditAdUrlTagsRegistration);
    const syncStore = createFirestoreSyncStore(db);

    await runSyncTask({
      syncStore,
      registry,
      taskType: "AUDIT_AD_URL_TAGS",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run_audit_2",
    });

    const state = await syncStore.getSyncState(syncStateKey("meta", "url_tag_audit"));
    expect(state).toBeNull();
  });
});
