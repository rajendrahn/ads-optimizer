// D4's own "Done when" bar, proven end to end against a real Firestore emulator, the REAL,
// unmodified D2 packet builder / D1 evidence engine (same RECOMPUTE_FEATURES -> COMPUTE_STATISTICS
// -> ENRICH_CHANGE_FEATURES pipeline decisionPacketStore.emulator.test.ts and reasoner.emulator.test.ts
// already exercise), and a SCRIPTED fake Anthropic client (no live API call — this is testing the
// PIPELINE, not the model, per this step's own "be frugal with live calls" instruction):
//
//   1. A request returns immediately with an ID, and the document is PENDING right away.
//   2. The document transitions PENDING -> GENERATING -> COMPLETE, and the GENERATING state is
//      genuinely observable mid-flight (not just theoretically reachable) before the model call
//      resolves.
//   3. A worker failure (the reasoner call itself throwing, simulating a real Anthropic-side
//      failure) leaves a legible FAILED state with a real errorMessage — never a doc stuck on
//      PENDING/GENERATING — and syncRuns records the same failure independently.
//   4. D5's real guardrail application (`applyGuardrails`): a REJECTED verdict downgrades the
//      stored recommendation to INSUFFICIENT_DATA, stamps `guardrailRejection`, and durably logs
//      the rejection to `guardrailRejections/{recommendationId}` — keyed by the REAL id, not a
//      synthesized one (see generateRecommendationTask.ts's own corrective note; this was a real
//      bug fixed post-D6, pre-Phase-E). 4b/4c prove the PRODUCTION DEFAULT — not a handler with
//      any injected guardrail override, since none exists any more — actually enforces this.
//   5. Duplicate delivery of the same enqueued task (Cloud Tasks' own at-least-once contract) is a
//      no-op the second time — B1's own idempotency, reused here without D4 reinventing it.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { GCP_PROJECT_ID } from "../../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  canonSettingsSchema,
  resetReportingCanonCacheForTests,
  addCalendarDays,
} from "@shared/canon/index.ts";
import {
  recommendationSchema,
  guardrailRejectionLogSchema,
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaInsightsDailyNormalizedSchema,
  shopifyDailyCoverageSchema,
  type Recommendation,
  type GuardrailRejectionLog,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
  type MetaInsightsDailyNormalized,
  type NormalizedMoney,
  type ReportingDay,
  type ShopifyDailyCoverage,
} from "@shared/schema/index.ts";
import { TEST_CANON } from "../../ingest/meta/entities/testFixtures.ts";
import { createTaskRegistry } from "../../ingest/sync/registry.ts";
import { createFirestoreSyncStore } from "../../ingest/sync/store.ts";
import { runSyncTask } from "../../ingest/sync/taskWrapper.ts";
import { createInMemoryTaskQueueClient } from "../../ingest/sync/taskQueue.ts";
import { GENERATE_RECOMMENDATION } from "../../ingest/sync/taskTypes.ts";
import type { RawArchiveStore } from "../../ingest/sync/archiver.ts";
import { requestRecommendation } from "./request.ts";
import {
  createGenerateRecommendationHandler,
  type GenerateRecommendationHandlerDeps,
} from "./generateRecommendationTask.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "generateRecommendationTask.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
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
  COLLECTIONS.recommendations,
  COLLECTIONS.adOptimizationKnowledge,
  COLLECTIONS.guardrailRejections,
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
  const registry = createTaskRegistry();
  // A minimal registry carrying just what generateAndCacheDecisionPacket needs underneath —
  // reuse the REAL registrations, not a fake, per D1/D2's own "reuse the real pipeline"
  // convention. Importing createDefaultRegistry() here would also work but pulls in every
  // other step's task types unnecessarily; this test only needs the recompute chain.
  const { recomputeFeaturesRegistration } = await import("../../analytics/features/index.ts");
  const { computeStatisticsRegistration } = await import("../../analytics/statistics/index.ts");
  const { enrichChangeFeaturesRegistration } =
    await import("../../analytics/changeFeatures/index.ts");
  registry.register(recomputeFeaturesRegistration);
  registry.register(computeStatisticsRegistration);
  registry.register(enrichChangeFeaturesRegistration);

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
    await seedAdVolume(adId, "AS_17", "cmp_1", 28, 30, 5_283_000, 20_000_000);
  }
  await seedCoverage("2026-08-03" as ReportingDay, AS_OF_DAY);
}

const VALID_MODEL_OUTPUT = {
  recommendation: "HOLD",
  decisionUnit: { type: "ADSET", id: "AS_17" },
  currentBudgetMinorUnits: 50000,
  recommendedBudgetMinorUnits: 50000,
  changePercent: 0,
  confidence: 0.6,
  summary: "Hold — CPA is above the placeholder target even though ROAS looks healthy.",
  primaryReasons: ["28-day CPA is above the placeholder target."],
  risks: ["Placeholder targets may not reflect this account's real economics."],
  doNotDo: ["Do not increase budget while CPA is above target."],
  recheckConditions: null,
};

function textBlock(json: unknown): Anthropic.Beta.BetaTextBlock {
  return { type: "text", text: JSON.stringify(json), citations: null };
}

function usage(overrides: Partial<Anthropic.Beta.BetaUsage> = {}): Anthropic.Beta.BetaUsage {
  return {
    input_tokens: 1200,
    output_tokens: 300,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1000,
    cache_creation: null,
    fallback_credit: null,
    inference_geo: null,
    server_tool_use: null,
    speed: null,
    ...overrides,
  } as Anthropic.Beta.BetaUsage;
}

/** Builds a minimal registry carrying ONLY the GENERATE_RECOMMENDATION task type, wired to a
 * scripted fake Anthropic client — exactly `createReasonerWorkerRegistry()`'s shape in
 * production (workerRegistry.ts), but with test-only overrides threaded through, matching
 * `createGenerateRecommendationHandler`'s own injection seam. */
function buildTestWorkerRegistry(deps: Parameters<typeof createGenerateRecommendationHandler>[0]) {
  const registry = createTaskRegistry();
  registry.register({
    taskType: GENERATE_RECOMMENDATION,
    runSource: "internal",
    syncStateTarget: null,
    handler: createGenerateRecommendationHandler(deps),
  });
  return registry;
}

/** Runs the ONE enqueued GENERATE_RECOMMENDATION task (from an in-memory queue) through
 * `runSyncTask`, exactly like the real Cloud Tasks HTTP target (workerRuntime.ts) would. */
async function dispatchEnqueuedRecommendationTask(
  enqueued: readonly { taskId: string; payload: unknown }[],
  registry: ReturnType<typeof createTaskRegistry>,
) {
  expect(enqueued).toHaveLength(1);
  const [task] = enqueued;
  const syncStore = createFirestoreSyncStore(db);
  return runSyncTask({
    syncStore,
    registry,
    taskType: GENERATE_RECOMMENDATION,
    payload: task.payload,
    taskId: task.taskId,
    archiver: dummyArchiver,
  });
}

async function getRecommendation(id: string): Promise<Recommendation> {
  const doc = await createRepository<Recommendation>(
    db,
    COLLECTIONS.recommendations,
    recommendationSchema,
  ).get(id);
  if (doc === null) throw new Error(`expected recommendations/${id} to exist`);
  return doc;
}

describe("GENERATE_RECOMMENDATION job pipeline — D4's own Done-when bar", () => {
  it("1) a request returns immediately with an ID, and the doc is PENDING right away", async () => {
    const queue = createInMemoryTaskQueueClient();
    const { recommendationId } = await requestRecommendation({
      db,
      queue,
      namedEntity: { type: "ADSET", id: "AS_17" },
      requestedBy: "rajendrahn38@gmail.com",
      requestedQuestion: "Should I increase the budget of AS_17?",
    });

    expect(recommendationId).toBeTruthy();
    const doc = await getRecommendation(recommendationId);
    expect(doc.status).toBe("PENDING");
    expect(doc.requestedBy).toBe("rajendrahn38@gmail.com");
    expect(doc.requestedQuestion).toBe("Should I increase the budget of AS_17?");
    expect(doc.recommendation).toBeNull();
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0].taskId).toBe(recommendationId); // reused as the idempotency key
  });

  it("2) the doc transitions PENDING -> GENERATING -> COMPLETE, GENERATING genuinely observable mid-flight", async () => {
    await seedDeliveringAdset();
    await runFullPipeline();

    const queue = createInMemoryTaskQueueClient();
    const { recommendationId } = await requestRecommendation({
      db,
      queue,
      namedEntity: { type: "ADSET", id: "AS_17" },
    });

    let sawGenerating = false;
    const create = vi.fn().mockImplementation(async () => {
      // Proves GENERATING was actually persisted BEFORE the model call resolves — not just
      // theoretically reachable. A client subscribed via onSnapshot would see this exact state.
      const midFlight = await getRecommendation(recommendationId);
      if (midFlight.status === "GENERATING") sawGenerating = true;
      return {
        id: "msg_1",
        model: "claude-fable-5",
        stop_reason: "end_turn",
        stop_details: null,
        content: [textBlock(VALID_MODEL_OUTPUT)],
        usage: usage(),
      };
    });
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;

    const registry = buildTestWorkerRegistry({ client: fakeClient });
    const result = await dispatchEnqueuedRecommendationTask(queue.enqueued, registry);
    expect(result.status).toBe("SUCCEEDED");
    expect(sawGenerating).toBe(true);

    const finalDoc = await getRecommendation(recommendationId);
    expect(finalDoc.status).toBe("COMPLETE");
    expect(finalDoc.recommendation).toBe("HOLD");
    expect(finalDoc.packetId).toBe("ADSET_AS_17");
    expect(finalDoc.confidence).toBe(0.6);
    expect(finalDoc.primaryReasons).toEqual(VALID_MODEL_OUTPUT.primaryReasons);
    expect(finalDoc.accountDataVersionAtGeneration).toBeGreaterThan(0);
    // §19.4 provenance, persisted field-for-field from D3's own buildProvenance — see D3's
    // "Notes for D4/D5".
    expect(finalDoc.provenance).not.toBeNull();
    expect(finalDoc.provenance?.model).toBe("claude-fable-5");
    expect(finalDoc.provenance?.provider).toBe("anthropic");
    expect(finalDoc.provenance?.stopReason).toBe("end_turn");
    expect(finalDoc.provenance?.decisionEngineVersion).toBe("d1-scaling-evidence-v1");
    expect(finalDoc.guardrailRejection).toBeNull();
    expect(finalDoc.errorMessage).toBeNull();
  });

  it("3) a genuine worker failure (the reasoner call itself throwing) leaves a legible FAILED state, not a stuck PENDING/GENERATING", async () => {
    await seedDeliveringAdset();
    await runFullPipeline();

    const queue = createInMemoryTaskQueueClient();
    const { recommendationId } = await requestRecommendation({
      db,
      queue,
      namedEntity: { type: "ADSET", id: "AS_17" },
    });

    // A REAL thrown error, simulating a genuine Anthropic-side failure (network blip, 5xx,
    // timeout) — not a scripted "error" JSON in the response body. This is what actually
    // reaching generateRecommendation's uncaught-exception path looks like.
    const create = vi.fn().mockRejectedValue(new Error("ECONNRESET: connection reset by peer"));
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;

    const registry = buildTestWorkerRegistry({ client: fakeClient });
    const result = await dispatchEnqueuedRecommendationTask(queue.enqueued, registry);

    // The task itself is recorded as FAILED in syncRuns (taskWrapper's own independent
    // bookkeeping) — the error was rethrown, not swallowed.
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/ECONNRESET/);

    // And the document itself — the thing a client is actually watching via onSnapshot — is
    // FAILED with a legible errorMessage, never left on PENDING or GENERATING.
    const finalDoc = await getRecommendation(recommendationId);
    expect(finalDoc.status).toBe("FAILED");
    expect(finalDoc.status).not.toBe("PENDING");
    expect(finalDoc.status).not.toBe("GENERATING");
    expect(finalDoc.errorMessage).toMatch(/ECONNRESET/);
    // No fabricated recommendation on a failure — every recommendation-shaped field stays null.
    expect(finalDoc.recommendation).toBeNull();
    expect(finalDoc.provenance).toBeNull();
  });

  it("4) D5's real guardrail (applyGuardrails): a REJECTED verdict downgrades to INSUFFICIENT_DATA, stamps guardrailRejection, and durably logs a rejection keyed by the REAL recommendationId", async () => {
    await seedDeliveringAdset();
    await runFullPipeline();

    const queue = createInMemoryTaskQueueClient();
    const { recommendationId } = await requestRecommendation({
      db,
      queue,
      namedEntity: { type: "ADSET", id: "AS_17" },
    });

    const create = vi.fn().mockResolvedValue({
      id: "msg_1",
      model: "claude-fable-5",
      stop_reason: "end_turn",
      stop_details: null,
      content: [
        textBlock({
          ...VALID_MODEL_OUTPUT,
          recommendation: "INCREASE_BUDGET",
          changePercent: 250, // a synthetic over-limit change — the REAL guardrail default max is 20%
        }),
      ],
      usage: usage(),
    });
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;

    // No injected guardrail behaviour of any kind — `createGenerateRecommendationHandler` has no
    // such option any more (see generateRecommendationTask.ts's own corrective note). The ONLY
    // override here is the Anthropic client, to avoid a live model call; `applyGuardrails` (D5's
    // real §20.2 logic) runs unconditionally and rejects this 250% change on its own numbers.
    const registry = buildTestWorkerRegistry({ client: fakeClient });
    const result = await dispatchEnqueuedRecommendationTask(queue.enqueued, registry);
    expect(result.status).toBe("SUCCEEDED"); // the TASK succeeded — the model's proposal was rejected, that's not a task failure

    const finalDoc = await getRecommendation(recommendationId);
    expect(finalDoc.status).toBe("REJECTED");
    expect(finalDoc.recommendation).toBe("INSUFFICIENT_DATA"); // §20.2: downgraded, not surfaced as-is
    expect(finalDoc.currentBudgetMinorUnits).toBeNull();
    expect(finalDoc.recommendedBudgetMinorUnits).toBeNull();
    expect(finalDoc.changePercent).toBeNull();
    expect(finalDoc.guardrailRejection).not.toBeNull();
    expect(finalDoc.guardrailRejection?.reason).toMatch(/exceeds the configured maximum/);
    expect(finalDoc.guardrailRejection?.rejectedAt).toBeInstanceOf(Date);
    // The model's own reasoning stays visible on a REJECTED doc (D4's own "Ambiguities resolved"
    // #4) — only the actionable budget fields are cleared, not the summary/reasons/risks/doNotDo.
    expect(finalDoc.summary).toBe(VALID_MODEL_OUTPUT.summary);
    expect(finalDoc.primaryReasons).toEqual(VALID_MODEL_OUTPUT.primaryReasons);

    // THE FIX THIS STEP MAKES: `guardrailRejections/{recommendationId}` — a plain keyed lookup by
    // the REAL id, no synthesis, no prefix scan. Before this fix, this exact `.get` would have
    // returned null (the entry was written under a synthesized `adapter_ADSET_AS_17_<epochMillis>`
    // id instead) — this is the join E3 (§20.2's own calibration-signal note) needs.
    const logRepo = createRepository<GuardrailRejectionLog>(
      db,
      COLLECTIONS.guardrailRejections,
      guardrailRejectionLogSchema,
    );
    const logged = await logRepo.get(recommendationId);
    expect(logged).not.toBeNull();
    expect(logged?.recommendationId).toBe(recommendationId);
    expect(logged?.violations.some((v) => v.code === "MAX_CHANGE_PERCENT_EXCEEDED")).toBe(true);
    expect(
      logged?.violations.find((v) => v.code === "MAX_CHANGE_PERCENT_EXCEEDED")?.judgedAgainst,
    ).toEqual({
      field: "guardrailThresholds.maxChangePercent",
      limit: 20,
      source: "default",
      actual: 250,
    });
    // The higher-fidelity fields the narrow adapter could never populate (no recommendationId in
    // scope there means no namedEntity/accountDataVersion either, in that integration) — now real.
    expect(logged?.namedEntity).toEqual({ type: "ADSET", id: "AS_17" });
    expect(logged?.accountDataVersion).toBe(finalDoc.accountDataVersionAtGeneration);
  });

  it("4b) THE test this whole class of bug needed: the PRODUCTION DEFAULT (no guardrail-related override at all) actually enforces guardrails, not a passthrough", async () => {
    // This is the regression test for the actual bug this step fixes: D4/D5 concurrently built
    // two integration paths (a real one and a stronger one), the production wiring used the
    // weaker one, and NOTHING in either step's own test suite caught it because every test
    // injected its own guardrail stand-in — see generateRecommendationTask.ts's own corrective
    // note on `generateRecommendationHandler` for the full history. There is no
    // `guardrailValidator` (or equivalent) option on `GenerateRecommendationHandlerDeps` any
    // more — the ONLY dependency overridden below is the Anthropic client, required to avoid a
    // live model call (this task's own safety constraint), which is orthogonal to guardrail
    // enforcement. Every other option — db aside, needed to point at the test project — is left
    // at its default, exactly like the exported `generateRecommendationHandler` (which cannot be
    // invoked directly here without a live Anthropic call via Secret Manager).
    await seedDeliveringAdset();
    await runFullPipeline();

    const queue = createInMemoryTaskQueueClient();
    const { recommendationId } = await requestRecommendation({
      db,
      queue,
      namedEntity: { type: "ADSET", id: "AS_17" },
    });

    const create = vi.fn().mockResolvedValue({
      id: "msg_1",
      model: "claude-fable-5",
      stop_reason: "end_turn",
      stop_details: null,
      content: [
        textBlock({
          ...VALID_MODEL_OUTPUT,
          recommendation: "INCREASE_BUDGET",
          changePercent: 999, // absurdly over-limit — if this passes, guardrails are not running
        }),
      ],
      usage: usage(),
    });
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;

    // `createGenerateRecommendationHandler({ db, client })` — db/client only, nothing
    // guardrail-shaped, because there is nothing guardrail-shaped left to pass. This IS the
    // production default's guardrail behaviour, unconditionally (see
    // generateRecommendationTask.ts's own comment on `generateRecommendationHandler`).
    const registry = createTaskRegistry();
    registry.register({
      taskType: GENERATE_RECOMMENDATION,
      runSource: "internal",
      syncStateTarget: null,
      handler: createGenerateRecommendationHandler({ db, client: fakeClient }),
    });

    const result = await dispatchEnqueuedRecommendationTask(queue.enqueued, registry);
    expect(result.status).toBe("SUCCEEDED");

    const finalDoc = await getRecommendation(recommendationId);
    // If a future change silently reintroduces a passthrough default, this is the assertion that
    // fails: a 999% change would be persisted as COMPLETE/INCREASE_BUDGET instead.
    expect(finalDoc.status).toBe("REJECTED");
    expect(finalDoc.recommendation).toBe("INSUFFICIENT_DATA");
    expect(finalDoc.changePercent).toBeNull();
    expect(finalDoc.guardrailRejection).not.toBeNull();
    expect(finalDoc.guardrailRejection?.reason).toMatch(/exceeds the configured maximum/);

    const logRepo = createRepository<GuardrailRejectionLog>(
      db,
      COLLECTIONS.guardrailRejections,
      guardrailRejectionLogSchema,
    );
    expect(await logRepo.get(recommendationId)).not.toBeNull();
  });

  it("4c) structural: GenerateRecommendationHandlerDeps has no guardrail-bypassing field — a future author cannot reintroduce one without a compile error", () => {
    // GenerateRecommendationHandlerDeps is exactly {db?, client?, effort?, now?} — no
    // `guardrailValidator` or equivalent. The object literal below only compiles because of the
    // `@ts-expect-error` suppressing it; deleting that comment and running `npm run typecheck`
    // reproduces `TS2353: Object literal may only specify known properties, and
    // 'guardrailValidator' does not exist in type 'GenerateRecommendationHandlerDeps'` — the same
    // enforcement mechanism guardrails.test.ts's own structural test uses for `GuardrailInput`.
    const deps: GenerateRecommendationHandlerDeps = {
      db,
      // @ts-expect-error — no such field exists any more; see generateRecommendationTask.ts's own
      // corrective note on `generateRecommendationHandler` for why it was removed.
      guardrailValidator: () => ({ verdict: "ACCEPTED" }),
    };
    expect(deps.db).toBe(db);
  });

  it("5) a duplicate delivery of the same enqueued task is a no-op the second time (B1's own idempotency, reused)", async () => {
    await seedDeliveringAdset();
    await runFullPipeline();

    const queue = createInMemoryTaskQueueClient();
    const { recommendationId } = await requestRecommendation({
      db,
      queue,
      namedEntity: { type: "ADSET", id: "AS_17" },
    });

    const create = vi.fn().mockResolvedValue({
      id: "msg_1",
      model: "claude-fable-5",
      stop_reason: "end_turn",
      stop_details: null,
      content: [textBlock(VALID_MODEL_OUTPUT)],
      usage: usage(),
    });
    const fakeClient = { beta: { messages: { create } } } as unknown as Anthropic;
    const registry = buildTestWorkerRegistry({ client: fakeClient });

    const first = await dispatchEnqueuedRecommendationTask(queue.enqueued, registry);
    expect(first.status).toBe("SUCCEEDED");
    expect(create).toHaveBeenCalledTimes(1);

    // Cloud Tasks' own at-least-once contract redelivers the SAME task (same taskId) — the
    // model must not be called a second time, and the doc must not move.
    const second = await dispatchEnqueuedRecommendationTask(queue.enqueued, registry);
    expect(second.status).toBe("SKIPPED_ALREADY_SUCCEEDED");
    expect(create).toHaveBeenCalledTimes(1);

    const finalDoc = await getRecommendation(recommendationId);
    expect(finalDoc.status).toBe("COMPLETE");
  });
});
