// One combined "fetch everything this run needs" helper, shared by both META_SYNC_ENTITIES
// (entitySync.ts) and META_SNAPSHOT_CONFIG (configSnapshot.ts) so the pagination/grouping logic
// isn't duplicated between them. Each task type still calls this — and so makes its own live
// Meta calls — independently: §10.2 requires "each task is idempotent [and] has retry
// behaviour" on its own, so META_SNAPSHOT_CONFIG must not depend on META_SYNC_ENTITIES having
// run first (or at all) in the same cycle. The cost is that both tasks read the account twice
// over per config-sync cycle (§25: "Meta config sync + snapshot: every 30-60 minutes") — a
// deliberate trade at this account's request volume against the alternative of one task type's
// retry silently depending on another's completion order.

import type { MetaClient } from "../client.ts";
import {
  fetchAccountCurrency,
  fetchAllAds,
  fetchAllAdsets,
  fetchAllCampaigns,
  fetchAllCreatives,
  type PaginatedFetchResult,
} from "./fetch.ts";
import type { RawMetaAd, RawMetaAdset, RawMetaCampaign, RawMetaCreative } from "./normalize.ts";

export interface FetchedMetaEntities {
  currency: string;
  campaigns: PaginatedFetchResult<RawMetaCampaign>;
  adsets: PaginatedFetchResult<RawMetaAdset>;
  ads: PaginatedFetchResult<RawMetaAd>;
  creatives: PaginatedFetchResult<RawMetaCreative>;
  /** Ad sets grouped by their parent campaign id — what budgetOwnership.ts's
   * `determineCampaignBudgetGivenChildren` needs, computed once here rather than by every
   * caller. */
  adsetsByCampaignId: Map<string, RawMetaAdset[]>;
}

export async function fetchAllMetaEntities(meta: MetaClient): Promise<FetchedMetaEntities> {
  // Fetched sequentially, not with Promise.all — the BUC pre-emptive throttle (A4 §7.1) reads
  // the *previous* response's usage before sending the next request; firing requests in
  // parallel would let several requests race ahead of a throttle decision that only updates
  // after each response lands.
  const currency = await fetchAccountCurrency(meta);
  const campaigns = await fetchAllCampaigns(meta);
  const adsets = await fetchAllAdsets(meta);
  const ads = await fetchAllAds(meta);
  const creatives = await fetchAllCreatives(meta);

  const adsetsByCampaignId = new Map<string, RawMetaAdset[]>();
  for (const adset of adsets.rows) {
    const list = adsetsByCampaignId.get(adset.campaign_id) ?? [];
    list.push(adset);
    adsetsByCampaignId.set(adset.campaign_id, list);
  }

  return { currency, campaigns, adsets, ads, creatives, adsetsByCampaignId };
}
