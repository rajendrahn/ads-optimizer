// Emulator-backed proof of B2's own "Done when" bar for META_SYNC_ENTITIES: "A full entity
// sync populates all four collections ... re-running produces no duplicates." Every Meta call
// is mocked (a real MetaClient with a canned `fetchImpl` — no live network call, no
// credentials needed); every Firestore call is real, against the emulator.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GCP_PROJECT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
} from "@shared/schema/index.ts";
import type { RawArchiveStore } from "../../sync/archiver.ts";
import { MetaClient } from "../client.ts";
import { metaSyncEntitiesHandler } from "./entitySync.ts";
import { TEST_CANON, buildTestFetchImpl } from "./testFixtures.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "entitySync.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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
    COLLECTIONS.metaAdsets,
    COLLECTIONS.metaAds,
    COLLECTIONS.metaCreatives,
    COLLECTIONS.metaEntitySyncJobs,
    COLLECTIONS.settings,
  ]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

beforeEach(async () => {
  resetReportingCanonCacheForTests();
  await cleanupCollections();
  const settingsRepo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
  await settingsRepo.set(TEST_CANON.accountId, TEST_CANON);
});

afterAll(async () => {
  await cleanupCollections();
});

/**
 * Drives a run to DONE, re-invoking with the SAME runId the way Cloud Tasks redelivery does.
 *
 * A complete sync no longer fits one invocation: the phase machine is
 * CAMPAIGNS -> ADSETS -> CAMPAIGNS_RESOLVE -> ADS -> CREATIVES -> ADS_RESOLVE, which is six
 * bounded units against a default `maxPagesPerInvocation` of 5, so the handler correctly
 * yields with "more work remaining" before finishing. That is the resumable design working,
 * not a regression - so a test asserting the FINAL state has to drive the run to completion
 * rather than assume one call does it.
 */
async function driveToCompletion(
  runId: string,
  client: MetaClient,
  payload: unknown = {},
  maxInvocations = 20,
) {
  let last: Awaited<ReturnType<typeof metaSyncEntitiesHandler>> | undefined;
  for (let i = 0; i < maxInvocations; i++) {
    try {
      last = await metaSyncEntitiesHandler(makeCtx(runId, client, payload));
      return last;
    } catch (err) {
      // "more work remaining" is the documented yield; anything else is a real failure.
      if (!/more work remaining/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
  throw new Error(`run ${runId} did not reach DONE within ${maxInvocations} invocations`);
}

function makeCtx(runId: string, client: MetaClient, payload: unknown = {}) {
  return {
    runId,
    taskType: "META_SYNC_ENTITIES",
    payload,
    archiver: dummyArchiver,
    getMetaClient: async () => client,
    getShopifyClient: async () => {
      throw new Error("should not be called");
    },
    recordVersionGuardRejection: () => undefined,
  };
}

function newTestClient(options: Parameters<typeof buildTestFetchImpl>[0] = {}): MetaClient {
  return new MetaClient({
    accessToken: "tok",
    fetchImpl: buildTestFetchImpl(options),
    sleepImpl: vi.fn().mockResolvedValue(undefined),
  });
}

async function countAllEntityDocs(): Promise<number> {
  const counts = await Promise.all(
    [
      COLLECTIONS.metaCampaigns,
      COLLECTIONS.metaAdsets,
      COLLECTIONS.metaAds,
      COLLECTIONS.metaCreatives,
    ].map(async (name) => (await db.collection(name).listDocuments()).length),
  );
  return counts.reduce((a, b) => a + b, 0);
}

describe("metaSyncEntitiesHandler (emulator)", () => {
  it("populates all four collections with correctly normalized data, budget ownership included", async () => {
    const result = await driveToCompletion("run_1", newTestClient());

    expect(result.newRowCount).toBe(3 + 2 + 3 + 2); // campaigns + adsets + ads + creatives
    expect(result.summary).toEqual({ campaigns: 3, adsets: 2, ads: 3, creatives: 2 });

    const campaignsRepo = createRepository(db, COLLECTIONS.metaCampaigns, metaCampaignSchema);
    const cbo = await campaignsRepo.get("cmp_cbo");
    expect(cbo?.budget).toEqual({
      ownerLevel: "CAMPAIGN",
      dailyBudgetMinorUnits: 50000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    });
    const abo = await campaignsRepo.get("cmp_abo");
    expect(abo?.budget).toBeNull(); // ad-set level owns it
    const orphan = await campaignsRepo.get("cmp_orphan");
    expect(orphan?.budget?.ownerLevel).toBe("UNKNOWN"); // no budget, no ad sets — genuinely unknown

    const adsetsRepo = createRepository(db, COLLECTIONS.metaAdsets, metaAdsetSchema);
    const underCbo = await adsetsRepo.get("as_under_cbo");
    expect(underCbo?.budget).toBeNull(); // consistent with the parent campaign owning it
    expect(underCbo?.placements).toEqual(["facebook", "instagram"]);
    const underAbo = await adsetsRepo.get("as_under_abo");
    expect(underAbo?.budget).toEqual({
      ownerLevel: "ADSET",
      dailyBudgetMinorUnits: 3000,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    });

    const adsRepo = createRepository(db, COLLECTIONS.metaAds, metaAdSchema);
    const adStandard = await adsRepo.get("ad_standard");
    expect(adStandard?.creativeId).toBe("cr_standard");
    expect(adStandard?.destinationUrl).toBe(
      "https://sparkleandglow.co.in/?utm_content=ad_standard",
    );
    const adNoCreative = await adsRepo.get("ad_no_creative");
    expect(adNoCreative?.creativeId).toBeNull();
    expect(adNoCreative?.destinationUrl).toBeNull();

    const creativesRepo = createRepository(db, COLLECTIONS.metaCreatives, metaCreativeSchema);
    const standard = await creativesRepo.get("cr_standard");
    expect(standard?.creativeType).toBe("STANDARD");
    const composite = await creativesRepo.get("cr_composite");
    expect(composite?.creativeType).toBe("COMPOSITE");
    expect(composite?.deliveredMixObservable).toBe(false);
    expect(composite?.memberAssetHashes).toEqual(["a1", "b2"]);
  });

  it("re-running produces no duplicates — the same Meta IDs are simply overwritten", async () => {
    await driveToCompletion("run_1", newTestClient());
    await driveToCompletion("run_2", newTestClient());

    const campaignDocs = await db.collection(COLLECTIONS.metaCampaigns).listDocuments();
    expect(campaignDocs).toHaveLength(3); // not 6 — same 3 IDs, overwritten in place
    const adsetDocs = await db.collection(COLLECTIONS.metaAdsets).listDocuments();
    expect(adsetDocs).toHaveLength(2);
    const adDocs = await db.collection(COLLECTIONS.metaAds).listDocuments();
    expect(adDocs).toHaveLength(3);
    const creativeDocs = await db.collection(COLLECTIONS.metaCreatives).listDocuments();
    expect(creativeDocs).toHaveLength(2);
  });

  // The point of the creative-narrowing fix, and NOT observable from Firestore state alone:
  // a creative that is never fetched and one that is fetched but writes an identical doc look
  // the same afterwards. Only the request log distinguishes them, which is why the fixture
  // records every requested id.
  it("fetches ONLY the creative ids referenced by ads, never the whole account", async () => {
    const fetchImpl = buildTestFetchImpl();
    const client = new MetaClient({
      accessToken: "tok",
      fetchImpl,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
    });

    await driveToCompletion("run_narrow", client);

    const requested = [...new Set(fetchImpl.requestedCreativeIds)].sort();
    // The fixture's ads reference exactly these two; ad_no_creative references none.
    expect(requested).toEqual(["cr_composite", "cr_standard"]);
    // And the account listing endpoint - the expensive one that assembled
    // object_story_spec/asset_feed_spec for every creative ever - is never called at all.
    const listingCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes("/adcreatives"),
    );
    expect(listingCalls).toHaveLength(0);
  });
});

describe("metaSyncEntitiesHandler (emulator) — convergence across retries (defect fix)", () => {
  it("makes forward progress every invocation under a tight per-invocation page budget, and resumes past a mid-run rate limit, ending with every entity present", async () => {
    // maxPagesPerInvocation:1 forces the run to span many invocations even though this small
    // fixture's every entity type fits in a single Meta page — CREATIVES, CAMPAIGNS, ADSETS,
    // CAMPAIGNS_RESOLVE and ADS are each their own bounded unit of work. `failFirstCallTo:
    // "adsets"` makes the FIRST live attempt at the /adsets edge return Meta's real
    // production error (code 80004, a retryable ApiError per classifyMetaError's whole-
    // 80000-family fix) instead of data; every later attempt at that edge succeeds normally
    // — proving the handler saves progress and resumes rather than restarting from page one.
    const client = newTestClient({ failFirstCallTo: "adsets" });
    const runId = "run_converge";
    const payload = { maxPagesPerInvocation: 1 };

    const docCountsAfterEachInvocation: number[] = [];
    const outcomes: ("threw" | "succeeded")[] = [];
    let finalResult: Awaited<ReturnType<typeof metaSyncEntitiesHandler>> | undefined;

    for (let invocation = 0; invocation < 20 && !finalResult; invocation++) {
      try {
        finalResult = await metaSyncEntitiesHandler(makeCtx(runId, client, payload));
        outcomes.push("succeeded");
      } catch {
        // Expected for every non-final invocation — B3's own "more work remains" pattern
        // (see entitySync.ts's module comment): the handler throws a plain retryable Error
        // (or, on the injected-failure invocation, propagates the rate-limited ApiError)
        // whenever the job isn't fully DONE yet. taskWrapper.ts is what actually turns this
        // into a redelivery in production; this test drives the handler directly, in a loop,
        // to prove the SAME thing taskWrapper's redelivery would.
        outcomes.push("threw");
      }
      docCountsAfterEachInvocation.push(await countAllEntityDocs());
    }

    expect(finalResult).toBeDefined();
    // Every invocation before the last one threw (mirrors pollAsyncReport.ts's "more pages
    // remain" pattern) — including the one where the injected rate limit hit. The run still
    // converged despite that.
    expect(outcomes.slice(0, -1).every((o) => o === "threw")).toBe(true);
    expect(outcomes.at(-1)).toBe("succeeded");

    // The core convergence claim: never zero after the first invocation that actually wrote
    // anything, and never decreasing — including across the invocation that hit the injected
    // rate limit (that invocation's fetch failed before writing anything new, so its count
    // legitimately repeats the previous one rather than growing, but it must never regress).
    for (let i = 1; i < docCountsAfterEachInvocation.length; i++) {
      expect(docCountsAfterEachInvocation[i]).toBeGreaterThanOrEqual(
        docCountsAfterEachInvocation[i - 1],
      );
    }
    expect(docCountsAfterEachInvocation[0]).toBeGreaterThan(0); // first invocation already wrote something
    expect(docCountsAfterEachInvocation.at(-1)).toBe(10); // 3 campaigns + 2 adsets + 3 ads + 2 creatives
    // Strictly increasing across the invocations that actually advance the job (i.e.
    // excluding the one that repeated a count because the injected rate limit hit before any
    // write) — proves real forward progress happened at every genuine step, not just at the
    // very end.
    const advancingCounts = [...new Set(docCountsAfterEachInvocation)];
    expect(advancingCounts).toEqual([...advancingCounts].sort((a, b) => a - b));
    expect(advancingCounts.length).toBeGreaterThan(1);

    // Final state: every entity present, correctly normalized — same assertions as the
    // single-invocation "Done when" test above, now proven reachable via many invocations.
    const campaignsRepo = createRepository(db, COLLECTIONS.metaCampaigns, metaCampaignSchema);
    expect((await campaignsRepo.get("cmp_cbo"))?.budget?.ownerLevel).toBe("CAMPAIGN");
    expect(await campaignsRepo.get("cmp_abo")).not.toBeNull();
    expect((await campaignsRepo.get("cmp_abo"))?.budget).toBeNull();
    expect((await campaignsRepo.get("cmp_orphan"))?.budget?.ownerLevel).toBe("UNKNOWN");
    const adsetsRepo = createRepository(db, COLLECTIONS.metaAdsets, metaAdsetSchema);
    expect(await adsetsRepo.get("as_under_cbo")).not.toBeNull();
    expect(await adsetsRepo.get("as_under_abo")).not.toBeNull();
    const adsRepo = createRepository(db, COLLECTIONS.metaAds, metaAdSchema);
    expect(await adsRepo.get("ad_standard")).not.toBeNull();
    expect(await adsRepo.get("ad_composite")).not.toBeNull();
    expect(await adsRepo.get("ad_no_creative")).not.toBeNull();
    const creativesRepo = createRepository(db, COLLECTIONS.metaCreatives, metaCreativeSchema);
    expect(await creativesRepo.get("cr_standard")).not.toBeNull();
    expect(await creativesRepo.get("cr_composite")).not.toBeNull();

    expect(finalResult?.newRowCount).toBe(10);
  });

  it("is idempotent: re-invoking an already-DONE run (same runId) is a safe no-op", async () => {
    const client = newTestClient();
    const runId = "run_done_twice";

    const first = await driveToCompletion(runId, client);
    expect(first.newRowCount).toBe(10);
    const countAfterFirst = await countAllEntityDocs();
    expect(countAfterFirst).toBe(10);

    // Same runId, already DONE — the job-doc short-circuit (mirrors B3's DONE-phase no-op).
    const second = await metaSyncEntitiesHandler(makeCtx(runId, client));
    expect(second.newRowCount).toBe(0);
    expect(second.summary).toMatchObject({ phase: "DONE" });
    expect(await countAllEntityDocs()).toBe(countAfterFirst); // unchanged, nothing duplicated
  });
});
