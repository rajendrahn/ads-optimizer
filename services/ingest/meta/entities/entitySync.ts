// META_SYNC_ENTITIES (§10.2) — campaigns, ad sets, ads and creatives normalized into Firestore.
//
// Meta is the single source of truth for *current* config state: every successful run
// replaces each collection's docs wholesale, keyed directly by Meta's own IDs (no version
// guard — see shared/schema/meta.ts's module comment for why that's the right call here,
// unlike Shopify/insights, whose writes can arrive out of order). Raw pages are archived
// verbatim, before normalization, for replay per §23.
//
// --- Defect fix: resumable, page-at-a-time, across invocations -------------------------
//
// B2's original handler called one `fetchAllMetaEntities(meta)` that paged every entity type
// to exhaustion in memory, and wrote to Firestore only once everything had been fetched. On
// this account (development-access tier; 410 campaigns/534 ad sets/1,139 ads — an order of
// magnitude past §7.1's "under 100 ads" assumption) that exhausts Meta's call budget partway
// through every single time (error 80004), and because nothing was written yet, a retry
// restarts from page one and dies at the same wall. Four consecutive production runs wrote
// zero documents.
//
// The fix follows B3's `metaInsightsReportJobs`/`pollAsyncReport.ts` precedent exactly:
// progress lives in a Firestore doc (`metaEntitySyncJobs/{runId}`, keyed by this task's own
// runId — see shared/schema/meta.ts's module comment on `metaEntitySyncJobSchema` for the
// full phase-machine rationale, including why campaign/ad-set/ad/creative can't simply be
// four independent per-page-writable loops). Each invocation advances the job by up to
// `maxPagesPerInvocation` bounded units, saving the job doc (and flushing every Firestore
// write via `BulkWriter#flush()`, so it's durable) after each one, BEFORE attempting the
// next Meta call. When the budget runs out with work still remaining, or when Meta itself
// rate-limits (surfaced as a retryable `ApiError` — `classifyMetaError` treats the whole
// 80000 family as retryable), the handler throws — a plain `Error` for "budget exhausted",
// or the original `ApiError` for "Meta said no" — and `taskWrapper.ts`'s `runSyncTask`
// classifies either as retryable, redelivering the SAME task id onto the SAME `syncRuns`
// doc. The next invocation resumes from the saved cursor rather than starting over. Nothing
// is ever lost: the only work "at risk" when an error is thrown is the one page/chunk in
// flight, which was never counted as done in the first place.
//
// What "replaces each collection's docs wholesale" now means, spread across invocations:
// it still describes the *complete, converged* state a fully-DONE run leaves behind — every
// entity Meta returned gets its Firestore doc written (or overwritten) at least once. What it
// no longer means is "atomically, at one instant" — a long-running job (under a tight budget,
// potentially over many invocations and real wall-clock time) writes different entities at
// different moments, so mid-run the collections are a mix of this run's freshest fetch and
// the previous run's stale-but-present state for anything not yet reached. This was already
// true in spirit before this fix (a single-invocation run still took nonzero time to fetch
// everything, and Firestore writes across ~2,000+ docs were never one atomic transaction
// either), just compressed into seconds instead of potentially minutes-to-hours; nothing
// about correctness changes, only the window's size. Entities that vanish from Meta entirely
// between runs are UNCHANGED by this fix either way: neither the original handler nor this
// one ever deletes a Firestore doc for an entity Meta stops returning — B4's notes already
// document this same gap for change-event derivation ("an entity that disappears entirely...
// produces no removed event"). This fix does not add, remove, or paper over that gap; it is
// simply orthogonal to it.

import { getDb } from "@shared/firestore/index.ts";
import { COLLECTIONS, collectionRef } from "@shared/firestore/index.ts";
import {
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
  type MetaEntitySyncJob,
} from "@shared/schema/index.ts";
import { loadReportingCanon, toReportingDay } from "@shared/canon/index.ts";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import { determineCampaignBudget, type RawMetaBudgetFields } from "./budgetOwnership.ts";
import {
  fetchAccountCurrency,
  fetchAdsPage,
  fetchAdsetsPage,
  fetchCampaignsPage,
  fetchCreativesPage,
} from "./fetch.ts";
import {
  normalizeAd,
  normalizeAdset,
  normalizeCampaign,
  normalizeCreative,
  type RawMetaCampaign,
} from "./normalize.ts";
import {
  createFirestoreEntitySyncJobStore,
  type EntitySyncJobStore,
} from "./entitySyncJobStore.ts";

export interface MetaSyncEntitiesPayload {
  /** Restrict every paged fetch (campaigns, ad sets, ads) to Meta's own
   * `effective_status=["ACTIVE"]` filter — dramatically cuts call volume, which is what
   * actually fits inside a development-access-tier budget: this account has 410
   * campaigns/534 ad sets/1,139 ads all-time, but B3 measured only ~47 active ad-days/day of
   * real delivery. Default `false` — the existing full/historical behaviour, unchanged
   * unless an operator opts in.
   *
   * Trade-off, stated plainly: an active-only sync is cheap and covers everything that is
   * actually delivering right now, but a paused/archived entity's Firestore doc simply isn't
   * re-fetched or re-written by an active-only run — it goes stale (frozen at whatever its
   * last full sync wrote) until a subsequent full (`activeOnly: false`) sync runs. Creatives
   * are always fetched in full either way — Meta's `/adcreatives` edge has no
   * `effective_status` of its own (see fetch.ts's `fetchCreativesPage`). Budget-ownership
   * resolution for a campaign whose children include paused ad sets can also be affected:
   * an active-only ADSETS phase only sees that campaign's *active* children, so a campaign
   * whose only budget-owning ad set happens to be paused would resolve to `UNKNOWN` instead
   * of `ADSET` under `activeOnly: true` — another instance of the same staleness trade-off,
   * not a separate bug. */
  activeOnly?: boolean;
  /** Page-equivalent units of work (one fetched-and-written page, or one CAMPAIGNS_RESOLVE
   * chunk) processed per invocation before saving progress and yielding back to the task
   * framework — default 5, mirroring B3's `pollAsyncReport.ts`'s `maxPagesPerInvocation`. */
  maxPagesPerInvocation?: number;
  /** Pending campaigns (ones whose budget ownership needed their ad sets — see
   * shared/schema/meta.ts's module comment) resolved per invocation "unit" during the
   * CAMPAIGNS_RESOLVE phase — default 200. */
  resolveChunkSize?: number;
}

function parsePayload(raw: unknown): MetaSyncEntitiesPayload {
  if (typeof raw !== "object" || raw === null) return {};
  return raw as MetaSyncEntitiesPayload;
}

/** The synthetic `childAdsets` array `budgetOwnership.ts`'s `determineCampaignBudgetGivenChildren`
 * needs to resolve a pending campaign, built from the small `{count, anyOwnsBudget}` aggregate
 * accumulated during the ADSETS phase rather than the full list of raw ad sets (which this job
 * never buffers — see shared/schema/meta.ts's module comment for why only the aggregate is
 * needed). Only `.length` and `.some(daily_budget/lifetime_budget != null)` are ever read from
 * this array, so any array satisfying those two properties is equivalent to the real thing. */
function buildSyntheticChildAdsets(agg: {
  count: number;
  anyOwnsBudget: boolean;
}): RawMetaBudgetFields[] {
  return Array.from({ length: agg.count }, (_, i) =>
    i === 0 && agg.anyOwnsBudget ? { daily_budget: "1" } : {},
  );
}

function newJob(
  runId: string,
  accountId: string,
  activeOnly: boolean,
  now: Date,
): MetaEntitySyncJob {
  return {
    runId,
    accountId,
    activeOnly,
    currency: null,
    phase: "CREATIVES",
    cursors: { creatives: null, campaigns: null, adsets: null, ads: null },
    creativeLinkUrlById: {},
    campaignOwnsBudgetById: {},
    pendingCampaigns: [],
    pendingCampaignAgg: {},
    resolveIndex: 0,
    counts: { creatives: 0, campaigns: 0, adsets: 0, ads: 0 },
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function advanceJob(
  ctx: Parameters<TaskHandler>[0],
  jobStore: EntitySyncJobStore,
  initialJob: MetaEntitySyncJob,
  currency: string,
  today: string,
  maxPagesPerInvocation: number,
  resolveChunkSize: number,
): Promise<MetaEntitySyncJob> {
  const db = getDb();
  const meta = await ctx.getMetaClient();
  const syncedAt = new Date();
  const normalizeCtx = { accountId: initialJob.accountId, currency, syncedAt };

  const campaignsRef = collectionRef(db, COLLECTIONS.metaCampaigns, metaCampaignSchema);
  const adsetsRef = collectionRef(db, COLLECTIONS.metaAdsets, metaAdsetSchema);
  const adsRef = collectionRef(db, COLLECTIONS.metaAds, metaAdSchema);
  const creativesRef = collectionRef(db, COLLECTIONS.metaCreatives, metaCreativeSchema);

  let job = initialJob;
  let unitsUsed = 0;
  const bulkWriter = db.bulkWriter();

  try {
    while (job.phase !== "DONE" && unitsUsed < maxPagesPerInvocation) {
      if (job.phase === "CREATIVES") {
        const page = await fetchCreativesPage(meta, job.cursors.creatives);
        unitsUsed++;
        await ctx.archiver.archive({
          source: "meta",
          day: today,
          resource: "creatives",
          runId: ctx.runId,
          payload: page.page,
        });
        const creativeLinkUrlById = { ...job.creativeLinkUrlById };
        for (const raw of page.rows) {
          const doc = normalizeCreative(raw, { accountId: normalizeCtx.accountId, syncedAt });
          bulkWriter.set(creativesRef.doc(doc.creativeId), doc);
          creativeLinkUrlById[doc.creativeId] = doc.linkUrl;
        }
        await bulkWriter.flush();
        job = {
          ...job,
          cursors: { ...job.cursors, creatives: page.nextAfter },
          creativeLinkUrlById,
          counts: { ...job.counts, creatives: job.counts.creatives + page.rows.length },
          phase: page.nextAfter ? "CREATIVES" : "CAMPAIGNS",
          updatedAt: new Date(),
        };
        await jobStore.set(ctx.runId, job);
        continue;
      }

      if (job.phase === "CAMPAIGNS") {
        const page = await fetchCampaignsPage(meta, job.cursors.campaigns, job.activeOnly);
        unitsUsed++;
        await ctx.archiver.archive({
          source: "meta",
          day: today,
          resource: "campaigns",
          runId: ctx.runId,
          payload: page.page,
        });
        const campaignOwnsBudgetById = { ...job.campaignOwnsBudgetById };
        const pendingCampaigns = [...job.pendingCampaigns];
        for (const raw of page.rows) {
          const ownBudget = determineCampaignBudget(raw, currency);
          campaignOwnsBudgetById[raw.id] = ownBudget !== null;
          if (ownBudget !== null) {
            // Own budget is final and needs no child ad sets — see normalizeCampaign, which
            // only consults `childAdsets` when the campaign itself has no budget.
            const doc = normalizeCampaign(raw, [], normalizeCtx);
            bulkWriter.set(campaignsRef.doc(doc.campaignId), doc);
          } else {
            // Deferred to CAMPAIGNS_RESOLVE, once every ad set is known.
            pendingCampaigns.push(raw as unknown as Record<string, unknown>);
          }
        }
        await bulkWriter.flush();
        job = {
          ...job,
          cursors: { ...job.cursors, campaigns: page.nextAfter },
          campaignOwnsBudgetById,
          pendingCampaigns,
          counts: { ...job.counts, campaigns: job.counts.campaigns + page.rows.length },
          phase: page.nextAfter ? "CAMPAIGNS" : "ADSETS",
          updatedAt: new Date(),
        };
        await jobStore.set(ctx.runId, job);
        continue;
      }

      if (job.phase === "ADSETS") {
        const page = await fetchAdsetsPage(meta, job.cursors.adsets, job.activeOnly);
        unitsUsed++;
        await ctx.archiver.archive({
          source: "meta",
          day: today,
          resource: "adsets",
          runId: ctx.runId,
          payload: page.page,
        });
        const pendingIds = new Set(job.pendingCampaigns.map((c) => (c as { id: string }).id));
        const pendingCampaignAgg = { ...job.pendingCampaignAgg };
        for (const raw of page.rows) {
          const campaignOwnsBudget = job.campaignOwnsBudgetById[raw.campaign_id] ?? false;
          const doc = normalizeAdset(raw, campaignOwnsBudget, normalizeCtx);
          bulkWriter.set(adsetsRef.doc(doc.adsetId), doc);
          if (pendingIds.has(raw.campaign_id)) {
            const prev = pendingCampaignAgg[raw.campaign_id] ?? {
              count: 0,
              anyOwnsBudget: false,
            };
            pendingCampaignAgg[raw.campaign_id] = {
              count: prev.count + 1,
              anyOwnsBudget:
                prev.anyOwnsBudget || raw.daily_budget != null || raw.lifetime_budget != null,
            };
          }
        }
        await bulkWriter.flush();
        job = {
          ...job,
          cursors: { ...job.cursors, adsets: page.nextAfter },
          pendingCampaignAgg,
          counts: { ...job.counts, adsets: job.counts.adsets + page.rows.length },
          phase: page.nextAfter ? "ADSETS" : "CAMPAIGNS_RESOLVE",
          updatedAt: new Date(),
        };
        await jobStore.set(ctx.runId, job);
        continue;
      }

      if (job.phase === "CAMPAIGNS_RESOLVE") {
        const chunk = job.pendingCampaigns.slice(
          job.resolveIndex,
          job.resolveIndex + resolveChunkSize,
        );
        if (chunk.length === 0) {
          // No pending campaigns at all (every campaign owned its own budget) — a free
          // phase transition, no Meta call and nothing to write, so it doesn't consume a
          // unit of this invocation's budget.
          job = { ...job, phase: "ADS", updatedAt: new Date() };
          await jobStore.set(ctx.runId, job);
          continue;
        }
        for (const rawUnknown of chunk) {
          const raw = rawUnknown as unknown as RawMetaCampaign;
          const agg = job.pendingCampaignAgg[raw.id] ?? { count: 0, anyOwnsBudget: false };
          const doc = normalizeCampaign(raw, buildSyntheticChildAdsets(agg), normalizeCtx);
          bulkWriter.set(campaignsRef.doc(doc.campaignId), doc);
        }
        await bulkWriter.flush();
        unitsUsed++;
        const resolveIndex = job.resolveIndex + chunk.length;
        job = {
          ...job,
          resolveIndex,
          phase: resolveIndex >= job.pendingCampaigns.length ? "ADS" : "CAMPAIGNS_RESOLVE",
          updatedAt: new Date(),
        };
        await jobStore.set(ctx.runId, job);
        continue;
      }

      // job.phase === "ADS"
      const page = await fetchAdsPage(meta, job.cursors.ads, job.activeOnly);
      unitsUsed++;
      await ctx.archiver.archive({
        source: "meta",
        day: today,
        resource: "ads",
        runId: ctx.runId,
        payload: page.page,
      });
      const creativeLinkUrlById = new Map(Object.entries(job.creativeLinkUrlById));
      for (const raw of page.rows) {
        const doc = normalizeAd(raw, {
          accountId: normalizeCtx.accountId,
          syncedAt,
          creativeLinkUrlById,
        });
        bulkWriter.set(adsRef.doc(doc.adId), doc);
      }
      await bulkWriter.flush();
      job = {
        ...job,
        cursors: { ...job.cursors, ads: page.nextAfter },
        counts: { ...job.counts, ads: job.counts.ads + page.rows.length },
        phase: page.nextAfter ? "ADS" : "DONE",
        updatedAt: new Date(),
      };
      await jobStore.set(ctx.runId, job);
    }
  } catch (err) {
    // Whatever's already been flushed to Firestore and saved to the job doc (every completed
    // unit, up to but not including the one in flight when this was thrown) is safely
    // durable — see this file's module comment. This is purely an observability marker.
    const message = err instanceof Error ? err.message : String(err);
    await jobStore.set(ctx.runId, { ...job, lastError: message, updatedAt: new Date() });
    // Rethrow unchanged. A rate-limited Meta call already surfaces as a retryable `ApiError`
    // (classifyMetaError's 80000-family fix) — taskWrapper.ts's classifyTaskError reads
    // `ApiError.retryable` directly, so there's no need for B3's "manufacture a plain Error"
    // trick here. That trick exists there for an in-band non-error condition ("still
    // polling" is a normal Meta response, not a thrown failure); this is a genuine exception.
    throw err;
  } finally {
    await bulkWriter.close();
  }

  return job;
}

export const metaSyncEntitiesHandler: TaskHandler = async (ctx) => {
  const payload = parsePayload(ctx.payload);
  const maxPagesPerInvocation = payload.maxPagesPerInvocation ?? 5;
  const resolveChunkSize = payload.resolveChunkSize ?? 200;

  const canon = await loadReportingCanon();
  const today = toReportingDay(new Date(), canon.reportingTimezone);
  const meta = await ctx.getMetaClient();
  const db = getDb();
  const jobStore = createFirestoreEntitySyncJobStore(db);

  let job = await jobStore.get(ctx.runId);
  if (!job) {
    job = newJob(ctx.runId, canon.accountId, payload.activeOnly ?? false, new Date());
    await jobStore.set(ctx.runId, job);
  }

  if (job.phase === "DONE") {
    // A redelivered/duplicate invocation after this run already finished — matches B3's
    // pollAsyncReport.ts DONE-phase idempotent no-op. taskWrapper.ts's own SUCCEEDED
    // short-circuit normally prevents this from even being reached, but this is defensive
    // for any caller that invokes the handler directly.
    return {
      newRowCount: 0,
      summary: { runId: ctx.runId, phase: "DONE", note: "already done", counts: job.counts },
    };
  }

  if (job.currency == null) {
    const currency = await fetchAccountCurrency(meta);
    job = { ...job, currency, updatedAt: new Date() };
    await jobStore.set(ctx.runId, job);
  }
  const currency = job.currency;
  if (currency == null) {
    // Unreachable (set immediately above) — narrows the type for advanceJob below.
    throw new Error("META_SYNC_ENTITIES: currency unexpectedly still null after fetch");
  }

  job = await advanceJob(
    ctx,
    jobStore,
    job,
    currency,
    today,
    maxPagesPerInvocation,
    resolveChunkSize,
  );

  if (job.phase !== "DONE") {
    // More work remains within this run — save is already done per-unit inside advanceJob;
    // yield back to the task framework so a redelivery of the SAME task id resumes from here.
    // Mirrors B3's pollAsyncReport.ts pageResults(): a plain (non-ApiError) Error, treated
    // retryable by taskWrapper's classifyTaskError default.
    throw new Error(
      `META_SYNC_ENTITIES: run ${ctx.runId} has more work remaining ` +
        `(phase=${job.phase}, counts=${JSON.stringify(job.counts)}) — will resume on retry`,
    );
  }

  return {
    newRowCount: job.counts.campaigns + job.counts.adsets + job.counts.ads + job.counts.creatives,
    summary: {
      campaigns: job.counts.campaigns,
      adsets: job.counts.adsets,
      ads: job.counts.ads,
      creatives: job.counts.creatives,
    },
  };
};

export const metaSyncEntitiesRegistration: TaskRegistration = {
  taskType: "META_SYNC_ENTITIES",
  runSource: "meta",
  syncStateTarget: { source: "meta", resource: "entities" },
  handler: metaSyncEntitiesHandler,
};
