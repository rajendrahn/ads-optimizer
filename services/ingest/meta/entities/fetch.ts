// Meta entity fetchers — thin cursor-pagination wrappers around `MetaClient.get()`. Raw JSON
// in, raw JSON out (the normalized rows plus every raw page body, for archiving) — no
// normalization here; that's normalize.ts's job, one layer up from A4's "MetaClient is
// transport-only" boundary.
//
// Page sizes are deliberately conservative for edges with heavy nested fields. Confirmed live
// during this step's planning: `/adcreatives` with `object_story_spec`/`asset_feed_spec`
// requested returns an HTTP 500 ("Please reduce the amount of data you're asking for") at
// limit=100 on this account, but succeeds at limit=25. Campaigns/ad sets/ads use only
// shallow fields and page cleanly at 100-200.

import { META_AD_ACCOUNT_ID } from "../../../../scripts/config.ts";
import type { MetaClient } from "../client.ts";
import type { RawMetaAd, RawMetaAdset, RawMetaCampaign, RawMetaCreative } from "./normalize.ts";

export interface PaginatedFetchResult<T> {
  rows: T[];
  /** Every raw page response body, in fetch order — archived verbatim by the caller (§23). */
  pages: unknown[];
}

interface MetaListResponse<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** One page of a Meta list edge — the primitive both `fetchAllPages` (below, for the
 * fetch-everything-in-one-call helpers `fetchAll.ts` depends on) and the post-B2 resumable
 * `META_SYNC_ENTITIES` job (entitySync.ts) are built on. Exposing this as its own function,
 * rather than only the looped `fetchAllPages` below, is what lets entitySync.ts persist a
 * cursor between invocations instead of paging to exhaustion inside one call. */
export interface MetaPageFetchResult<T> {
  rows: T[];
  /** The raw page response body — archived verbatim by the caller (§23). */
  page: unknown;
  /** Meta's `after` cursor for the next page, or `null` when this was the last page. */
  nextAfter: string | null;
}

async function fetchOnePage<T>(
  meta: MetaClient,
  path: string,
  fields: string,
  limit: number,
  after: string | null,
  extraParams: Record<string, string> = {},
): Promise<MetaPageFetchResult<T>> {
  const params: Record<string, string> = { fields, limit: String(limit), ...extraParams };
  if (after) params.after = after;
  const { data } = await meta.get<MetaListResponse<T>>(path, params);
  const cursorAfter = data.paging?.cursors?.after;
  const nextAfter = data.paging?.next && cursorAfter ? cursorAfter : null;
  return { rows: data.data, page: data, nextAfter };
}

async function fetchAllPages<T>(
  meta: MetaClient,
  path: string,
  fields: string,
  limit: number,
): Promise<PaginatedFetchResult<T>> {
  const rows: T[] = [];
  const pages: unknown[] = [];
  let after: string | null = null;

  for (;;) {
    const result: MetaPageFetchResult<T> = await fetchOnePage<T>(meta, path, fields, limit, after);
    pages.push(result.page);
    rows.push(...result.rows);
    if (!result.nextAfter) break;
    after = result.nextAfter;
  }

  return { rows, pages };
}

/** Meta's `effective_status` filter, JSON-array-encoded per its own query convention
 * (`effective_status=["ACTIVE"]`) — confirmed live during B2's planning to work identically
 * on /campaigns, /adsets and /ads. This is the post-B2 defect fix's `activeOnly` payload
 * flag's mechanism: restricting a sync to only currently-active entities cuts call volume
 * dramatically (most of this account's 2,000+ entities are old/paused history — B3 measured
 * only ~47 active ad-days/day of real delivery), at the cost of leaving paused/archived
 * entities stale in Firestore until a full (non-active-only) sync next runs. */
function effectiveStatusParam(activeOnly: boolean): Record<string, string> {
  return activeOnly ? { effective_status: JSON.stringify(["ACTIVE"]) } : {};
}

/** One page of campaigns, resumable via `after`. `activeOnly` applies §-flag filtering —
 * see `effectiveStatusParam`'s comment. */
export function fetchCampaignsPage(
  meta: MetaClient,
  after: string | null,
  activeOnly = false,
): Promise<MetaPageFetchResult<RawMetaCampaign>> {
  return fetchOnePage(
    meta,
    `/${META_AD_ACCOUNT_ID}/campaigns`,
    CAMPAIGN_FIELDS,
    200,
    after,
    effectiveStatusParam(activeOnly),
  );
}

/** One page of ad sets, resumable via `after`. */
export function fetchAdsetsPage(
  meta: MetaClient,
  after: string | null,
  activeOnly = false,
): Promise<MetaPageFetchResult<RawMetaAdset>> {
  return fetchOnePage(
    meta,
    `/${META_AD_ACCOUNT_ID}/adsets`,
    ADSET_FIELDS,
    200,
    after,
    effectiveStatusParam(activeOnly),
  );
}

/** One page of ads, resumable via `after`. */
export function fetchAdsPage(
  meta: MetaClient,
  after: string | null,
  activeOnly = false,
): Promise<MetaPageFetchResult<RawMetaAd>> {
  return fetchOnePage(
    meta,
    `/${META_AD_ACCOUNT_ID}/ads`,
    AD_FIELDS,
    100,
    after,
    effectiveStatusParam(activeOnly),
  );
}

/** One page of creatives, resumable via `after`. No `activeOnly` parameter at all (rather
 * than a silently-ignored one) — Meta's /adcreatives edge has no `effective_status` concept
 * of its own (a creative isn't active/paused; the ads that use it are), so there is nothing
 * for the flag to do here. */
export function fetchCreativesPage(
  meta: MetaClient,
  after: string | null,
): Promise<MetaPageFetchResult<RawMetaCreative>> {
  return fetchOnePage(meta, `/${META_AD_ACCOUNT_ID}/adcreatives`, CREATIVE_FIELDS, 25, after);
}

/** One minimal live call: the ad account's own billing currency, authoritative for
 * interpreting every campaign/ad-set budget field this run fetches (§5.2: "store an explicit
 * currency code on every money field"). Not assumed to equal the reporting canon's currency —
 * they happen to coincide on this account (both INR), but the account's own field is the
 * correct source of truth for what currency ITS budget numbers are actually in. */
export async function fetchAccountCurrency(meta: MetaClient): Promise<string> {
  const { data } = await meta.get<{ currency?: string }>(`/${META_AD_ACCOUNT_ID}`, {
    fields: "currency",
  });
  if (!data.currency) {
    throw new Error("fetchAccountCurrency: Meta returned no currency for the ad account");
  }
  return data.currency;
}

const CAMPAIGN_FIELDS =
  "id,name,status,objective,buying_type,daily_budget,lifetime_budget,bid_strategy,created_time,updated_time";
export function fetchAllCampaigns(
  meta: MetaClient,
): Promise<PaginatedFetchResult<RawMetaCampaign>> {
  return fetchAllPages(meta, `/${META_AD_ACCOUNT_ID}/campaigns`, CAMPAIGN_FIELDS, 200);
}

const ADSET_FIELDS =
  "id,campaign_id,name,status,daily_budget,lifetime_budget,optimization_goal,bid_strategy,targeting,created_time,updated_time";
export function fetchAllAdsets(meta: MetaClient): Promise<PaginatedFetchResult<RawMetaAdset>> {
  return fetchAllPages(meta, `/${META_AD_ACCOUNT_ID}/adsets`, ADSET_FIELDS, 200);
}

const AD_FIELDS = "id,adset_id,campaign_id,name,status,created_time,updated_time,creative{id}";
export function fetchAllAds(meta: MetaClient): Promise<PaginatedFetchResult<RawMetaAd>> {
  return fetchAllPages(meta, `/${META_AD_ACCOUNT_ID}/ads`, AD_FIELDS, 100);
}

const CREATIVE_FIELDS =
  "id,name,image_hash,video_id,body,title,link_url,object_story_spec,asset_feed_spec";
export function fetchAllCreatives(
  meta: MetaClient,
): Promise<PaginatedFetchResult<RawMetaCreative>> {
  return fetchAllPages(meta, `/${META_AD_ACCOUNT_ID}/adcreatives`, CREATIVE_FIELDS, 25);
}
