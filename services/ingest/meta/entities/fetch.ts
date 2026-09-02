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
//
// --- Creative-narrowing fix (this session) --------------------------------------------------
// Meta's `X-Business-Use-Case-Usage` header, measured live on this account, showed the binding
// constraint on META_SYNC_ENTITIES was CPU time (`total_cputime: 113%`, over budget), not call
// count (`call_count: 5%`) — root-caused to `fetchAllCreatives`/the old CREATIVES phase paging
// EVERY creative the account has ever had (4,000+, still growing) through `/adcreatives`, each
// page assembling `object_story_spec`/`asset_feed_spec` for 25 creatives at once. Most of those
// creatives belong to ads nobody runs any more. `fetchCreativesByIds` below fetches only
// creatives actually referenced by this run's ads (known from `AD_FIELDS`'s `creative{id}` —
// see entitySync.ts's ADS/CREATIVES phases for how the referenced-id set is collected and
// consumed), via Meta's `?ids=a,b,c&fields=...` multi-get syntax — one call per batch instead
// of one call per 25-creative page of the ENTIRE account. `fetchAllCreatives` (unchanged,
// still used by `fetchAllMetaEntities`/`configSnapshot.ts` — deliberately out of scope for this
// session, see IMPLEMENTATION_PLAN.md B2 notes) still fetches every creative; only
// META_SYNC_ENTITIES's own CREATIVES phase was switched to the narrower fetch.

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

export interface CreativeIdsBatchFetchResult {
  rows: RawMetaCreative[];
  /** The raw multi-get response body — archived verbatim by the caller (§23). `null` when
   * `ids` was empty (no call made). */
  page: unknown;
}

/** Fetch a batch of creatives by id in ONE request, via Meta's `?ids=a,b,c&fields=...`
 * multi-get syntax at the bare API-version root (ids are globally addressable Graph API
 * object ids, not scoped under `/{account}/adcreatives` — no cursor pagination applies here,
 * this is a single request for exactly the ids given). This is what replaces "page every
 * creative on the account" with "fetch only the ones this run's ads reference" — see this
 * file's module comment and IMPLEMENTATION_PLAN.md B2's creative-narrowing notes for the
 * measured CPU-time defect this fixes. `entitySync.ts`'s CREATIVES phase chunks the full
 * referenced-id set and calls this once per chunk, treating each call as one bounded unit of
 * work, same as any other phase.
 *
 * An id Meta doesn't return anything for (deleted/inaccessible) is simply absent from the
 * response object and therefore from `rows` — not surfaced as a per-id error here, matching
 * Meta's own documented multi-get behaviour (a missing id is silently omitted).
 *
 * Batch size is the caller's concern (`entitySync.ts`'s `creativeIdsBatchSize`, default 25) —
 * chosen to match this account's already-confirmed-safe `/adcreatives` page limit for this
 * identical heavy field list (see this file's module comment); not independently verified live
 * for the `?ids=` endpoint specifically, since this session's safety constraints forbid any
 * live Meta call. If a real run ever hits the same "reduce the amount of data" error at 25 via
 * this endpoint, lower `creativeIdsBatchSize` the same way B2 originally found 25 for the
 * cursor-paginated edge — the fetch primitive itself needs no change. */
export async function fetchCreativesByIds(
  meta: MetaClient,
  ids: string[],
): Promise<CreativeIdsBatchFetchResult> {
  if (ids.length === 0) return { rows: [], page: null };

  // ONE GET PER ID, sequentially - not `?ids=a,b,c`.
  //
  // The multi-get form was the obvious choice and it is GONE: Meta answers it with
  // `HTTP 500: The ids query parameter is deprecated in v26.0+`, which this account hits
  // despite config naming v21.0 (Meta serves a newer version once an app goes Live). Worse,
  // that 500 classifies as a retryable server error, so a retry loop backs off for hours
  // against a condition no retry can fix. Found on a real run, after the change had already
  // paged campaigns/adsets/ads successfully.
  //
  // Per-id GETs preserve the entire point of the narrowing fix. The binding constraint on this
  // account is CPU time, not call count (measured: call_count 5%, total_cputime 113%), and CPU
  // is driven by how many creatives get assembled with object_story_spec/asset_feed_spec - not
  // by how many HTTP requests carry them. Fetching N referenced creatives one-per-call costs
  // roughly the same CPU as N/25 batched calls and vastly less than listing all 4,000+ on the
  // account. Call count rises, into the ~95% of that budget we are not using.
  //
  // Sequential, not Promise.all: MetaClient self-throttles per request against the
  // X-Business-Use-Case-Usage header (sec 7.1), and firing a batch concurrently would sail
  // straight past that pre-emption - the exact thing it exists to prevent.
  const rows: RawMetaCreative[] = [];
  const pages: unknown[] = [];
  for (const id of ids) {
    const { data } = await meta.get<Record<string, unknown>>(`/${id}`, {
      fields: CREATIVE_FIELDS,
    });
    pages.push(data);
    // A deleted or inaccessible creative can come back without an id; skip rather than
    // fabricate a placeholder, matching the multi-get behaviour this replaces.
    if (data && typeof data === "object" && "id" in data) {
      rows.push(data as unknown as RawMetaCreative);
    }
  }
  return { rows, page: pages };
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
