// Meta collections — §8: metaCampaigns, metaAdsets, metaAds, metaCreatives,
// metaInsightsDaily, metaEntitySnapshots, metaChangeEvents.
//
// Populated by B2 (entities + snapshots), B3 (insights), B4 (change events). This file only
// fixes the shape; none of it is written here (A2 is out of scope for populating anything).

import { z } from "zod";
import {
  attributionProvenance,
  budgetOwnership,
  firestoreTimestamp,
  reportingDay,
} from "./common.ts";

// ---------------------------------------------------------------------------------------
// metaCampaigns/{campaignId}  ·  metaAdsets/{adsetId}  ·  metaAds/{adId}
//
// Keyed directly by Meta's own IDs — see shared/firestore/collections.ts. These are
// replaced wholesale on every B2 sync (Meta is the single source of truth for current
// config state, fetched sequentially), not version-guarded like Shopify/insights writes —
// see shared/firestore/versionGuard.ts's module comment for why that distinction matters.
// ---------------------------------------------------------------------------------------

export const metaCampaignSchema = z.object({
  campaignId: z.string().min(1),
  accountId: z.string().min(1),
  name: z.string(),
  status: z.string(), // Meta's own enum: ACTIVE, PAUSED, DELETED, ARCHIVED, ...
  objective: z.string().nullable(),
  buyingType: z.string().nullable(),
  budget: budgetOwnership.nullable(), // null when this campaign does not own budget (§4.1)
  bidStrategy: z.string().nullable(),
  createdAt: firestoreTimestamp,
  metaUpdatedAt: firestoreTimestamp,
  syncedAt: firestoreTimestamp,
});
export type MetaCampaign = z.infer<typeof metaCampaignSchema>;

export const metaAdsetSchema = z.object({
  adsetId: z.string().min(1),
  campaignId: z.string().min(1),
  accountId: z.string().min(1),
  name: z.string(),
  status: z.string(),
  budget: budgetOwnership.nullable(),
  optimizationGoal: z.string().nullable(),
  bidStrategy: z.string().nullable(),
  targeting: z.record(z.string(), z.unknown()).nullable(), // opaque — mirrors whatever Meta returns
  placements: z.array(z.string()).nullable(),
  attribution: attributionProvenance.nullable(), // ad-set-level setting, can differ from account default
  createdAt: firestoreTimestamp,
  metaUpdatedAt: firestoreTimestamp,
  syncedAt: firestoreTimestamp,
});
export type MetaAdset = z.infer<typeof metaAdsetSchema>;

export const metaAdSchema = z.object({
  adId: z.string().min(1),
  adsetId: z.string().min(1),
  campaignId: z.string().min(1),
  accountId: z.string().min(1),
  creativeId: z.string().nullable(),
  name: z.string(),
  status: z.string(),
  destinationUrl: z.string().nullable(), // B7's UTM audit parses this
  createdAt: firestoreTimestamp,
  metaUpdatedAt: firestoreTimestamp,
  syncedAt: firestoreTimestamp,
});
export type MetaAd = z.infer<typeof metaAdSchema>;

// ---------------------------------------------------------------------------------------
// metaCreatives/{creativeId} — Meta's own creative object, distinct from creativeAssets/
// (shared/schema/creative.ts), which is our own hash-based identity construct for pooling
// (§7.3, §11.1). One metaCreative can point at the same underlying asset as another.
// ---------------------------------------------------------------------------------------

export const metaCreativeSchema = z.object({
  creativeId: z.string().min(1),
  accountId: z.string().min(1),
  name: z.string().nullable(),
  imageHash: z.string().nullable(),
  videoId: z.string().nullable(),
  // §7.3: a dynamic/Advantage+ creative is a set of combinations with no single asset hash.
  creativeType: z.enum(["STANDARD", "COMPOSITE"]),
  memberAssetHashes: z.array(z.string()).nullable(), // COMPOSITE only
  deliveredMixObservable: z.boolean().nullable(), // COMPOSITE only, always false there (§7.3)
  bodyText: z.string().nullable(),
  headline: z.string().nullable(),
  linkUrl: z.string().nullable(),
  syncedAt: firestoreTimestamp,
});
export type MetaCreative = z.infer<typeof metaCreativeSchema>;

// ---------------------------------------------------------------------------------------
// metaInsightsDaily/{adId}_{date} — §9.5's given example key. Version-guarded (B3): see
// shared/firestore/versionGuard.ts. `sourceUpdatedAt` here is the *fetch/reconciliation
// timestamp*, not a per-row field Meta provides — see that module's comment for why.
// ---------------------------------------------------------------------------------------

export const metaInsightsDailySchema = z.object({
  adId: z.string().min(1),
  adsetId: z.string().min(1),
  campaignId: z.string().min(1),
  accountId: z.string().min(1),
  date: reportingDay, // native Meta-account-timezone day this row covers (§5.1); C1 remaps to canon
  attribution: attributionProvenance, // §5.3 — not optional
  spendMinorUnits: z.number().int().nonnegative(),
  currency: z.string().length(3),
  impressions: z.number().int().nonnegative(),
  reach: z.number().int().nonnegative().nullable(),
  frequency: z.number().nonnegative().nullable(),
  clicks: z.number().int().nonnegative(),
  // §7.2 funnel actions, retained for C2's funnel rates.
  landingPageViews: z.number().int().nonnegative(),
  addToCart: z.number().int().nonnegative(),
  initiateCheckout: z.number().int().nonnegative(),
  purchases: z.number().int().nonnegative(), // under `attribution` above
  purchaseValueMinorUnits: z.number().int().nonnegative(),
  sourceUpdatedAt: firestoreTimestamp, // version-guard field — see module comment above
  fetchedAt: firestoreTimestamp,
});
export type MetaInsightsDaily = z.infer<typeof metaInsightsDailySchema>;

// ---------------------------------------------------------------------------------------
// metaEntitySnapshots — §9.2: "on every config sync, snapshot budget, status, targeting,
// bid strategy and creative assignment for every entity". One flexible shape across
// CAMPAIGN/ADSET/AD; B2 populates only the fields relevant to that entity type.
// ---------------------------------------------------------------------------------------

export const metaEntitySnapshotSchema = z.object({
  entityType: z.enum(["CAMPAIGN", "ADSET", "AD"]),
  entityId: z.string().min(1),
  syncRunId: z.string().min(1), // ties this snapshot to the run that produced it — see key helper
  takenAt: firestoreTimestamp,
  budget: budgetOwnership.nullable(),
  status: z.string(),
  targeting: z.record(z.string(), z.unknown()).nullable(),
  bidStrategy: z.string().nullable(),
  creativeAssignment: z.array(z.string()).nullable(), // creative IDs attached at snapshot time
});
export type MetaEntitySnapshot = z.infer<typeof metaEntitySnapshotSchema>;

// ---------------------------------------------------------------------------------------
// metaChangeEvents — §9.2/§13: derived by diffing consecutive metaEntitySnapshots, never
// from Meta's activity feed (used only for `actor`, optionally).
// ---------------------------------------------------------------------------------------

export const metaChangeEventFieldSchema = z.enum([
  "BUDGET",
  "STATUS",
  "TARGETING",
  "BID_STRATEGY",
  "CREATIVE_ASSIGNMENT",
]);
export type MetaChangeEventField = z.infer<typeof metaChangeEventFieldSchema>;

export const metaChangeEventSchema = z.object({
  entityType: z.enum(["CAMPAIGN", "ADSET", "AD"]),
  entityId: z.string().min(1),
  field: metaChangeEventFieldSchema,
  detectedAt: firestoreTimestamp,
  fromSnapshotKey: z.string().min(1),
  toSnapshotKey: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
  // Populated only when field === "BUDGET" — B4: "before, after and percent".
  budgetChangePercent: z.number().nullable(),
  // §9.2: "Meta's activity feed is used only for actor attribution... and never as the
  // record that a change occurred" — optional enrichment, never load-bearing.
  actor: z.string().nullable(),
});
export type MetaChangeEvent = z.infer<typeof metaChangeEventSchema>;

// ---------------------------------------------------------------------------------------
// metaInsightsReportJobs/{reportRunId} — B3's own bookkeeping for the async report job state
// machine (§7.1: "submit the request, poll report_run_id, then page the results"). NOT one of
// §8's named collections — §8 was written before the implementation detail of a stateful async
// poll loop was worked out. Treated the same way `syncRuns`/`syncState` are: infrastructure the
// task framework needs, not a namespace §8's "do not namespace speculatively" warns against.
//
// Wholesale-overwritten on every state transition, like `syncRuns` — NOT run through
// `upsertWithVersionGuard`. That guard exists for Meta/Shopify-*sourced* business data that can
// arrive out of order from multiple writers (§9.5); this document has exactly one writer (the
// META_SYNC_INSIGHTS/META_POLL_ASYNC_REPORT task chain advancing its own job) and no source
// `updated_at` of its own to compare against — it's process state, not a measurement.
//
// `attribution` is captured here at SUBMISSION time and carried through every later phase
// transition, rather than re-read from `loadReportingCanon()` while paging results — a
// long-running backfill could in principle span a canon change mid-flight (§5.3: "when either
// changes, emit a first-class change event"), and every row this job produces must carry the
// attribution that was ACTUALLY used to generate the underlying Meta report, not whatever the
// canon says today.
// ---------------------------------------------------------------------------------------

export const metaInsightsReportJobReasonSchema = z.enum([
  "backfill",
  "reconciliation_incremental",
  "reconciliation_deep",
]);
export type MetaInsightsReportJobReason = z.infer<typeof metaInsightsReportJobReasonSchema>;

export const metaInsightsReportJobPhaseSchema = z.enum([
  "SUBMITTED", // report_run_id obtained from Meta, not yet polled
  "POLLING", // Meta has reported a non-terminal async_status at least once
  "PAGING", // Meta reported "Job Completed"; paging results, possibly across >1 invocation
  "DONE", // fully paged, every row upserted
  "FAILED", // Meta reported a terminal failure, or pollAttempts exceeded the configured cap
]);
export type MetaInsightsReportJobPhase = z.infer<typeof metaInsightsReportJobPhaseSchema>;

export const metaInsightsReportJobSchema = z.object({
  reportRunId: z.string().min(1),
  reason: metaInsightsReportJobReasonSchema,
  since: reportingDay, // inclusive
  until: reportingDay, // inclusive
  attribution: attributionProvenance, // §5.3 — pinned at submission, see module comment
  phase: metaInsightsReportJobPhaseSchema,
  // Meta's `after` cursor to resume paging from — set once PAGING starts, advanced (or reset to
  // null on completion) after every processed page. Lets a bounded-per-invocation poll resume
  // exactly where the previous invocation left off rather than re-paging from the start.
  pageCursor: z.string().nullable(),
  rowsWritten: z.number().int().nonnegative(), // cumulative across every invocation
  pollAttempts: z.number().int().nonnegative(),
  // The META_SYNC_INSIGHTS syncRuns id that submitted this job — traceability only.
  submittedByRunId: z.string().min(1),
  lastError: z.string().nullable(),
  createdAt: firestoreTimestamp,
  updatedAt: firestoreTimestamp,
});
export type MetaInsightsReportJob = z.infer<typeof metaInsightsReportJobSchema>;

// ---------------------------------------------------------------------------------------
// adUrlTagAudits/{adId} — B7's AUDIT_AD_URL_TAGS task (§6.3: "A scheduled job parses the
// destination URL of every live ad. Any ad whose URL does not yield a resolvable ad ID is
// excluded from Shopify-attributed metrics and surfaced in the UI — never silently reported as
// zero revenue."). Not one of §8's named collections — same category as
// metaInsightsReportJobs/syncRuns: our own derived audit state, not business data, so it's not
// a namespacing violation of §8's "one brand, one ad account, do not namespace speculatively."
//
// Deliberately NOT the metaAds document itself: metaAds is wholesale-replaced by B2 on every
// full sync and is not owned by this step, so writing the audit result there would either
// require coupling this task to B2's write path or risk being silently wiped by the next B2
// run. This collection is instead wholesale-overwritten by AUDIT_AD_URL_TAGS itself, keyed
// directly by adId (current state only — no history kept; if a trend over time is ever needed,
// key by (adId, auditRunId) instead, mirroring metaEntitySnapshots).
// ---------------------------------------------------------------------------------------

export const adUrlTagKindSchema = z.enum([
  "ID_MACRO", // utm_content={{ad.id}} or utm_campaign={{campaign.id}} — resolvable
  "NAME_MACRO", // {{ad.name}}/{{campaign.name}} — resolvable only via the weaker NAME_MATCH path
  "STATIC_TEXT", // a literal string present, neither macro — Open Question #1's dominant case
  "MISSING", // a destination URL exists but carries no utm_content/utm_campaign at all
  "NO_URL", // the ad has no destination URL captured at all
]);
export type AdUrlTagKind = z.infer<typeof adUrlTagKindSchema>;

export const adUrlTagAuditSchema = z.object({
  adId: z.string().min(1),
  auditedAt: firestoreTimestamp,
  destinationUrl: z.string().nullable(),
  utmContentRaw: z.string().nullable(),
  utmCampaignRaw: z.string().nullable(),
  tagKind: adUrlTagKindSchema,
  // true only for ID_MACRO — the one tag shape guaranteed to produce a resolvable numeric ID
  // on every real click, per §6.1's audit requirement.
  resolvable: z.boolean(),
});
export type AdUrlTagAudit = z.infer<typeof adUrlTagAuditSchema>;
