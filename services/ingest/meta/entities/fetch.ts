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

async function fetchAllPages<T>(
  meta: MetaClient,
  path: string,
  fields: string,
  limit: number,
): Promise<PaginatedFetchResult<T>> {
  const rows: T[] = [];
  const pages: unknown[] = [];
  let after: string | undefined;

  for (;;) {
    const params: Record<string, string> = { fields, limit: String(limit) };
    if (after) params.after = after;
    const { data } = await meta.get<MetaListResponse<T>>(path, params);
    pages.push(data);
    rows.push(...data.data);
    const nextAfter = data.paging?.cursors?.after;
    if (!data.paging?.next || !nextAfter) break;
    after = nextAfter;
  }

  return { rows, pages };
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
