// The pure resolution core of B7's attribution join (§6.1) — no Firestore, no I/O. Given a raw
// `landingSite` string and an index of known Meta entities, decides how (if at all) an order
// resolves to an ad.
//
// Resolution methods, per the B7 spec (a user decision, not a design default):
//   - "AD_ID" — the tag carried a Meta-minted numeric ID (`utm_content={{ad.id}}` or
//     `utm_campaign={{campaign.id}}`, expanded) that matches a real, known entity. High
//     confidence — this is exactly what §6.1 describes as the intended join.
//   - "NAME_MATCH" — the tag carried a human-readable name (Open Question #1's measured,
//     dominant case: 48/10,001 orders) that matches exactly one live/historical entity's name.
//     ⚠️ Lower confidence, always — names are neither unique nor stable over time, so this can
//     attribute revenue to the WRONG ad (e.g. a since-renamed or reused name). Never conflate
//     with AD_ID in anything downstream.
//   - "UNRESOLVED" — no landingSite, no recognized Meta-traffic signal, no match, or (see
//     below) an AMBIGUOUS name match. §6.2/§6.3: an unresolved order is missing measurement,
//     not evidence of zero influence — callers must never treat it as zero Shopify revenue for
//     any ad.
//
// Gating on `normalizedSource === "meta"` before ANY ad/campaign match is a deliberate,
// documented choice (not forced by the spec's wording, which only asks to "normalize the
// inconsistent utm_source spellings... when deciding what counts as Meta traffic"): a
// coincidental utm_content collision on non-Meta traffic (e.g. a Google-tagged order whose
// utm_content happens to equal a Meta ad's name) must not be resolved. This is conservative by
// design, consistent with the evidence-first principle (§3.2) — see this step's Notes in
// IMPLEMENTATION_PLAN.md for the full reasoning and its one real cost (an order tagged with an
// unrecognized 5th utm_source spelling would be skipped; extend
// utmTag.ts's KNOWN_META_UTM_SOURCE_VALUES if AUDIT_AD_URL_TAGS or a later join run turns one
// up).

import { type NormalizedName, buildNameIndex, lookupByName } from "./nameMatch.ts";
import { parseAttributionTag } from "./utmTag.ts";

export type ResolutionMethod = "AD_ID" | "NAME_MATCH" | "UNRESOLVED";

/** Confidence assigned to every AD_ID resolution — a real Meta-minted ID matched a known
 * entity; as high as this join mechanism ever gets. */
export const AD_ID_CONFIDENCE = 1;

/** Confidence assigned to every NAME_MATCH resolution. Deliberately well below AD_ID's 1 —
 * "lower confidence... on every name-resolved order" (spec, verbatim) — and deliberately NOT
 * 0, since a unique name match on live account data is still real (if weak) evidence, not
 * noise. 0.4 is a documented, round choice: below the 0.5 "more likely than not" midpoint (a
 * name match should never carry more weight than a coin flip on which ad it names), so any
 * consumer that naively averages confidences instead of segmenting by method (which the spec
 * forbids anyway — "never silently pool them") is at least pulled toward caution rather than
 * false precision. */
export const NAME_MATCH_CONFIDENCE = 0.4;

export interface AdNameCandidate {
  adId: string;
  campaignId: string;
}
export interface CampaignNameCandidate {
  campaignId: string;
}

/** Everything the resolver needs about the account's known Meta entities. Built once per join
 * run by `buildAttributionIndex` (attributionIndex.ts) from Firestore's `metaAds`/
 * `metaCampaigns` — deliberately entity-status-agnostic (includes PAUSED/ARCHIVED/DELETED),
 * matching B2's own all-time, all-status fetch: a 2025 historical order can only ever resolve
 * against the ad/campaign IDs and names that existed then, most of which are no longer ACTIVE
 * today. */
export interface AttributionIndex {
  adIds: ReadonlySet<string>;
  campaignIds: ReadonlySet<string>;
  /** adId -> its campaignId, so an AD_ID resolution can also populate resolvedCampaignId. */
  adCampaignById: ReadonlyMap<string, string>;
  adNameIndex: ReadonlyMap<NormalizedName, AdNameCandidate[]>;
  campaignNameIndex: ReadonlyMap<NormalizedName, CampaignNameCandidate[]>;
}

/** Builds an `AttributionIndex` from plain entity lists — the pure half; `attributionIndex.ts`
 * wraps this with the Firestore read. Split out so this module's own tests never need a
 * Firestore/emulator dependency. */
export function buildAttributionIndexFromEntities(
  ads: readonly { adId: string; campaignId: string; name: string }[],
  campaigns: readonly { campaignId: string; name: string }[],
): AttributionIndex {
  return {
    adIds: new Set(ads.map((a) => a.adId)),
    campaignIds: new Set(campaigns.map((c) => c.campaignId)),
    adCampaignById: new Map(ads.map((a) => [a.adId, a.campaignId])),
    adNameIndex: buildNameIndex(
      ads.map((a) => ({ adId: a.adId, campaignId: a.campaignId, __name: a.name })),
      (a) => a.__name,
    ),
    campaignNameIndex: buildNameIndex(
      campaigns.map((c) => ({ campaignId: c.campaignId, __name: c.name })),
      (c) => c.__name,
    ),
  };
}

export interface OrderAttributionResolution {
  /** The raw query string parsed (§6.1: "store the raw tag string alongside the resolved ID"),
   * so a future mapping correction can be replayed without re-fetching from Shopify. `null`
   * when there was no landingSite at all; `null` (not `""`) when there was a landingSite but no
   * query string on it — both are "nothing to store," distinguished instead by whether the
   * order's own `landingSite` field is itself null (that distinction lives on the order doc,
   * not here). */
  rawAttributionTag: string | null;
  resolvedAdId: string | null;
  resolvedCampaignId: string | null;
  resolutionMethod: ResolutionMethod;
  resolutionConfidence: number | null;
  /** Populated only when a NAME_MATCH attempt found more than one candidate — the spec's
   * "handle ambiguous name matches explicitly rather than picking one." Not persisted onto the
   * order document (no schema field for it — resolutionMethod already says UNRESOLVED); the
   * caller (resolveAttribution.ts) aggregates this into the task's own summary so an ambiguity
   * is visible in syncRuns/logs rather than silently discarded. */
  ambiguousNameCandidateIds: string[] | null;
}

const UNRESOLVED_BASE: Omit<OrderAttributionResolution, "rawAttributionTag"> = {
  resolvedAdId: null,
  resolvedCampaignId: null,
  resolutionMethod: "UNRESOLVED",
  resolutionConfidence: null,
  ambiguousNameCandidateIds: null,
};

const NUMERIC_ID = /^\d+$/;

export function resolveOrderAttribution(
  landingSite: string | null | undefined,
  index: AttributionIndex,
): OrderAttributionResolution {
  const parsed = parseAttributionTag(landingSite);
  if (parsed === null) {
    // No landingSite at all — §6.3's untagged-order rule starts here: this is missing
    // measurement, not absent influence.
    return { rawAttributionTag: null, ...UNRESOLVED_BASE };
  }

  const rawAttributionTag = parsed.rawQueryString.length > 0 ? parsed.rawQueryString : null;

  // Gate on a recognized Meta-traffic signal before attempting any match — see module comment.
  if (parsed.normalizedSource !== "meta") {
    return { rawAttributionTag, ...UNRESOLVED_BASE };
  }

  // 1. AD_ID — utm_content as a numeric Meta ad ID (the intended §6.1 join).
  if (parsed.utmContent !== null && NUMERIC_ID.test(parsed.utmContent)) {
    const adId = parsed.utmContent;
    if (index.adIds.has(adId)) {
      return {
        rawAttributionTag,
        resolvedAdId: adId,
        resolvedCampaignId: index.adCampaignById.get(adId) ?? null,
        resolutionMethod: "AD_ID",
        resolutionConfidence: AD_ID_CONFIDENCE,
        ambiguousNameCandidateIds: null,
      };
    }
  }

  // 1b. AD_ID at campaign granularity — utm_campaign as a numeric Meta campaign ID, when the
  // ad-level attempt above didn't resolve. Still an ID match (real confidence), just coarser.
  if (parsed.utmCampaign !== null && NUMERIC_ID.test(parsed.utmCampaign)) {
    const campaignId = parsed.utmCampaign;
    if (index.campaignIds.has(campaignId)) {
      return {
        rawAttributionTag,
        resolvedAdId: null,
        resolvedCampaignId: campaignId,
        resolutionMethod: "AD_ID",
        resolutionConfidence: AD_ID_CONFIDENCE,
        ambiguousNameCandidateIds: null,
      };
    }
  }

  // 2. NAME_MATCH cascade — utm_content against ad names, then campaign names; utm_campaign
  // against campaign names, then ad names. First non-"no-match" result wins; an ambiguous hit
  // stops the cascade rather than falling through to a weaker guess.
  const adByContent = lookupByName(index.adNameIndex, parsed.utmContent);
  if (adByContent.kind === "unique") {
    return {
      rawAttributionTag,
      resolvedAdId: adByContent.entity.adId,
      resolvedCampaignId: adByContent.entity.campaignId,
      resolutionMethod: "NAME_MATCH",
      resolutionConfidence: NAME_MATCH_CONFIDENCE,
      ambiguousNameCandidateIds: null,
    };
  }
  if (adByContent.kind === "ambiguous") {
    return {
      rawAttributionTag,
      ...UNRESOLVED_BASE,
      ambiguousNameCandidateIds: adByContent.candidates.map((c) => c.adId),
    };
  }

  const campaignByContent = lookupByName(index.campaignNameIndex, parsed.utmContent);
  if (campaignByContent.kind === "unique") {
    return {
      rawAttributionTag,
      resolvedAdId: null,
      resolvedCampaignId: campaignByContent.entity.campaignId,
      resolutionMethod: "NAME_MATCH",
      resolutionConfidence: NAME_MATCH_CONFIDENCE,
      ambiguousNameCandidateIds: null,
    };
  }
  if (campaignByContent.kind === "ambiguous") {
    return {
      rawAttributionTag,
      ...UNRESOLVED_BASE,
      ambiguousNameCandidateIds: campaignByContent.candidates.map((c) => c.campaignId),
    };
  }

  const campaignByCampaignTag = lookupByName(index.campaignNameIndex, parsed.utmCampaign);
  if (campaignByCampaignTag.kind === "unique") {
    return {
      rawAttributionTag,
      resolvedAdId: null,
      resolvedCampaignId: campaignByCampaignTag.entity.campaignId,
      resolutionMethod: "NAME_MATCH",
      resolutionConfidence: NAME_MATCH_CONFIDENCE,
      ambiguousNameCandidateIds: null,
    };
  }
  if (campaignByCampaignTag.kind === "ambiguous") {
    return {
      rawAttributionTag,
      ...UNRESOLVED_BASE,
      ambiguousNameCandidateIds: campaignByCampaignTag.candidates.map((c) => c.campaignId),
    };
  }

  const adByCampaignTag = lookupByName(index.adNameIndex, parsed.utmCampaign);
  if (adByCampaignTag.kind === "unique") {
    return {
      rawAttributionTag,
      resolvedAdId: adByCampaignTag.entity.adId,
      resolvedCampaignId: adByCampaignTag.entity.campaignId,
      resolutionMethod: "NAME_MATCH",
      resolutionConfidence: NAME_MATCH_CONFIDENCE,
      ambiguousNameCandidateIds: null,
    };
  }
  if (adByCampaignTag.kind === "ambiguous") {
    return {
      rawAttributionTag,
      ...UNRESOLVED_BASE,
      ambiguousNameCandidateIds: adByCampaignTag.candidates.map((c) => c.adId),
    };
  }

  return { rawAttributionTag, ...UNRESOLVED_BASE };
}
