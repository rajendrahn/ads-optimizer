// Pure Meta -> Firestore normalization for campaigns, ad sets, ads and creatives (§7.1, §9.1).
// No Firestore, no network — raw Meta JSON in, typed + zod-validated `shared/schema` objects
// out. Budget ownership is delegated to budgetOwnership.ts; everything else here is either a
// direct field rename or a documented best-effort derivation where Meta's API doesn't expose
// the field directly (destination URL, placements, creative body/headline/link).

import {
  metaAdSchema,
  metaAdsetSchema,
  metaCampaignSchema,
  metaCreativeSchema,
  type MetaAd,
  type MetaAdset,
  type MetaCampaign,
  type MetaCreative,
} from "@shared/schema/index.ts";
import {
  determineAdsetBudget,
  determineCampaignBudgetGivenChildren,
  type RawMetaBudgetFields,
} from "./budgetOwnership.ts";

// ---------------------------------------------------------------------------------------
// Raw Meta shapes — only the fields this module actually reads (services/ingest/meta/
// entities/fetch.ts's field lists must stay a superset of what's used here).
// ---------------------------------------------------------------------------------------

export interface RawMetaCampaign extends RawMetaBudgetFields {
  id: string;
  name: string;
  status: string;
  objective?: string | null;
  buying_type?: string | null;
  bid_strategy?: string | null;
  created_time: string;
  updated_time: string;
}

export interface RawMetaAdset extends RawMetaBudgetFields {
  id: string;
  campaign_id: string;
  name: string;
  status: string;
  optimization_goal?: string | null;
  bid_strategy?: string | null;
  targeting?: Record<string, unknown> | null;
  created_time: string;
  updated_time: string;
}

export interface RawMetaAd {
  id: string;
  adset_id: string;
  campaign_id: string;
  name: string;
  status: string;
  creative?: { id: string } | null;
  created_time: string;
  updated_time: string;
}

interface MetaChildAttachment {
  image_hash?: string;
  video_id?: string;
}
interface MetaLinkData {
  link?: string;
  message?: string;
  name?: string;
  child_attachments?: MetaChildAttachment[];
}
interface MetaObjectStorySpec {
  link_data?: MetaLinkData;
}
interface MetaAssetFeedSpecImage {
  hash?: string;
}
interface MetaAssetFeedSpecVideo {
  video_id?: string;
}
interface MetaAssetFeedSpec {
  images?: MetaAssetFeedSpecImage[];
  videos?: MetaAssetFeedSpecVideo[];
}

export interface RawMetaCreative {
  id: string;
  name?: string | null;
  image_hash?: string | null;
  video_id?: string | null;
  body?: string | null;
  title?: string | null;
  link_url?: string | null;
  object_story_spec?: MetaObjectStorySpec | null;
  asset_feed_spec?: MetaAssetFeedSpec | null;
}

// ---------------------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------------------

export interface NormalizeAccountCtx {
  accountId: string;
  currency: string;
  syncedAt: Date;
}

export function normalizeCampaign(
  raw: RawMetaCampaign,
  childAdsets: RawMetaBudgetFields[],
  ctx: NormalizeAccountCtx,
): MetaCampaign {
  return metaCampaignSchema.parse({
    campaignId: raw.id,
    accountId: ctx.accountId,
    name: raw.name,
    status: raw.status,
    objective: raw.objective ?? null,
    buyingType: raw.buying_type ?? null,
    budget: determineCampaignBudgetGivenChildren(raw, childAdsets, ctx.currency),
    bidStrategy: raw.bid_strategy ?? null,
    createdAt: new Date(raw.created_time),
    metaUpdatedAt: new Date(raw.updated_time),
    syncedAt: ctx.syncedAt,
  });
}

/** Best-effort: Meta's ad-set `targeting.publisher_platforms` is the closest analogue to
 * "placements" §7.1 asks to ingest — there is no single `placements` field on the ad set
 * object itself (placements are a targeting sub-structure, not a first-class field). `null`
 * when that sub-field isn't present rather than fabricating a value. */
function derivePlacements(targeting: Record<string, unknown> | null | undefined): string[] | null {
  if (!targeting) return null;
  const platforms = targeting.publisher_platforms;
  if (Array.isArray(platforms) && platforms.every((p) => typeof p === "string")) {
    return platforms as string[];
  }
  return null;
}

export function normalizeAdset(
  raw: RawMetaAdset,
  campaignOwnsBudget: boolean,
  ctx: NormalizeAccountCtx,
): MetaAdset {
  return metaAdsetSchema.parse({
    adsetId: raw.id,
    campaignId: raw.campaign_id,
    accountId: ctx.accountId,
    name: raw.name,
    status: raw.status,
    budget: determineAdsetBudget({ adset: raw, campaignOwnsBudget, currency: ctx.currency }),
    optimizationGoal: raw.optimization_goal ?? null,
    bidStrategy: raw.bid_strategy ?? null,
    targeting: raw.targeting ?? null,
    placements: derivePlacements(raw.targeting),
    // Deliberately left null — see IMPLEMENTATION_PLAN.md B2 notes. Meta's per-ad-set
    // `attribution_spec` carries a click/view attribution window but no purchase-action-type
    // component, so a faithful `attributionProvenance` (which needs both) can't be built from
    // this endpoint alone without silently substituting an account-wide default for the
    // missing half. B3 (insights) is where this field is actually load-bearing — every
    // `metaInsightsDaily` row requires it non-null, populated from the insights query itself.
    attribution: null,
    createdAt: new Date(raw.created_time),
    metaUpdatedAt: new Date(raw.updated_time),
    syncedAt: ctx.syncedAt,
  });
}

export interface NormalizeAdCtx {
  accountId: string;
  syncedAt: Date;
  /** creativeId -> that creative's normalized `linkUrl` — built from the same run's creative
   * fetch, so an ad's destination URL is derived from its own assigned creative without a
   * second, heavier per-ad fetch (an ad's `creative{link_url,...}` sub-fields are expensive
   * enough at this account's scale — 1,139+ ads live — to trip Meta's own "reduce the amount
   * of data" limit; see fetch.ts). B7's UTM audit is the step that actually validates this URL
   * carries a resolvable ad ID — B2 only captures it. */
  creativeLinkUrlById: Map<string, string | null>;
}

export function normalizeAd(raw: RawMetaAd, ctx: NormalizeAdCtx): MetaAd {
  const creativeId = raw.creative?.id ?? null;
  const destinationUrl = creativeId ? (ctx.creativeLinkUrlById.get(creativeId) ?? null) : null;
  return metaAdSchema.parse({
    adId: raw.id,
    adsetId: raw.adset_id,
    campaignId: raw.campaign_id,
    accountId: ctx.accountId,
    creativeId,
    name: raw.name,
    status: raw.status,
    destinationUrl,
    createdAt: new Date(raw.created_time),
    metaUpdatedAt: new Date(raw.updated_time),
    syncedAt: ctx.syncedAt,
  });
}

function extractLinkUrl(raw: RawMetaCreative): string | null {
  if (raw.link_url) return raw.link_url;
  return raw.object_story_spec?.link_data?.link ?? null;
}
function extractBodyText(raw: RawMetaCreative): string | null {
  if (raw.body) return raw.body;
  return raw.object_story_spec?.link_data?.message ?? null;
}
function extractHeadline(raw: RawMetaCreative): string | null {
  if (raw.title) return raw.title;
  return raw.object_story_spec?.link_data?.name ?? null;
}

/** Every asset hash/video id findable in a composite creative's spec, deduplicated. Sourced
 * from `asset_feed_spec` (dynamic/Advantage+ creative combinations) and, for the
 * carousel-shaped `object_story_spec.link_data.child_attachments` form observed live on this
 * account, from there too — both are creative structures Meta considers "a set of
 * combinations" per §7.3, not a single asset. */
function extractMemberAssetHashes(raw: RawMetaCreative): string[] | null {
  const hashes = new Set<string>();
  for (const img of raw.asset_feed_spec?.images ?? []) {
    if (img.hash) hashes.add(img.hash);
  }
  for (const vid of raw.asset_feed_spec?.videos ?? []) {
    if (vid.video_id) hashes.add(vid.video_id);
  }
  for (const child of raw.object_story_spec?.link_data?.child_attachments ?? []) {
    if (child.image_hash) hashes.add(child.image_hash);
    if (child.video_id) hashes.add(child.video_id);
  }
  return hashes.size > 0 ? [...hashes] : null;
}

export function normalizeCreative(
  raw: RawMetaCreative,
  ctx: { accountId: string; syncedAt: Date },
): MetaCreative {
  // §7.3: "A dynamic or Advantage+ creative is a set of combinations whose delivered mix is
  // largely unobservable... it has no single asset hash." `asset_feed_spec`'s presence is
  // exactly that signal — confirmed live (57/160 sampled creatives on this account carry it,
  // each with multiple body/image variants and `optimization_type: "DEGREES_OF_FREEDOM"`).
  const isComposite = raw.asset_feed_spec != null;
  return metaCreativeSchema.parse({
    creativeId: raw.id,
    accountId: ctx.accountId,
    name: raw.name ?? null,
    imageHash: raw.image_hash ?? null,
    videoId: raw.video_id ?? null,
    creativeType: isComposite ? "COMPOSITE" : "STANDARD",
    memberAssetHashes: isComposite ? extractMemberAssetHashes(raw) : null,
    deliveredMixObservable: isComposite ? false : null,
    bodyText: extractBodyText(raw),
    headline: extractHeadline(raw),
    linkUrl: extractLinkUrl(raw),
    syncedAt: ctx.syncedAt,
  });
}
