// AUDIT_AD_URL_TAGS (§10.2, §6.3) — "A scheduled job parses the destination URL of every live
// ad. Any ad whose URL does not yield a resolvable ad ID is excluded from Shopify-attributed
// metrics and surfaced in the UI — never silently reported as zero revenue."
//
// This is the OTHER half of B7's join, and per this step's own "Notes for the planning agent"
// the one to run first: it tells you whether the account's live tags are even capable of
// resolving before you build the join around them. Open Question #1 already ran this
// investigation once, by hand, against the historical Matrixify export (Browser: Ad URL was
// empty on every row; live tags turned out to be static human names, not `{{ad.id}}`/
// `{{ad.name}}` macros at all) — this module is the durable, re-runnable, per-ad version of
// that finding, operating on B2's already-ingested `metaAds.destinationUrl` (no live Meta call
// needed — see this step's implementation notes for why that's a deliberate reading of "parse
// every live ad's destination URL").

import { collectionRef, COLLECTIONS, createRepository, getDb } from "@shared/firestore/index.ts";
import { adUrlTagAuditSchema, metaAdSchema, type AdUrlTagKind } from "@shared/schema/index.ts";
import type { Firestore } from "firebase-admin/firestore";
import type { TaskRegistration } from "../../sync/registry.ts";
import type { TaskHandler } from "../../sync/taskWrapper.ts";
import { parseAttributionTag } from "./utmTag.ts";

const AD_ID_MACRO = "{{ad.id}}";
const CAMPAIGN_ID_MACRO = "{{campaign.id}}";
const AD_NAME_MACRO = "{{ad.name}}";
const CAMPAIGN_NAME_MACRO = "{{campaign.name}}";

export interface AdUrlAuditResult {
  adId: string;
  destinationUrl: string | null;
  utmContentRaw: string | null;
  utmCampaignRaw: string | null;
  tagKind: AdUrlTagKind;
  /** True only for ID_MACRO — the one shape Meta will expand into a real, resolvable numeric
   * ID on every real click. NAME_MACRO/STATIC_TEXT can, at best, feed the weaker NAME_MATCH
   * fallback once an order actually arrives — they are not "resolvable" in the sense this audit
   * flags, which is specifically "will the ID join work." */
  resolvable: boolean;
}

/** Pure — parses one ad's destination URL and classifies its UTM tag shape. Never throws. */
export function auditAdDestinationUrl(
  adId: string,
  destinationUrl: string | null,
): AdUrlAuditResult {
  if (destinationUrl === null || destinationUrl.trim().length === 0) {
    return {
      adId,
      destinationUrl: null,
      utmContentRaw: null,
      utmCampaignRaw: null,
      tagKind: "NO_URL",
      resolvable: false,
    };
  }

  // destinationUrl is non-empty, so parseAttributionTag never returns null here — a bare URL
  // with no query string still yields a ParsedAttributionTag with every param null. Guarded
  // (rather than asserted) so a genuine null here fails loudly instead of masking a bug.
  const parsed = parseAttributionTag(destinationUrl);
  if (parsed === null) {
    throw new Error(
      `auditAdDestinationUrl: parseAttributionTag unexpectedly returned null for a non-empty destinationUrl (ad ${adId})`,
    );
  }
  const utmContentRaw = parsed.utmContent;
  const utmCampaignRaw = parsed.utmCampaign;

  let tagKind: AdUrlTagKind;
  if (utmContentRaw === AD_ID_MACRO || utmCampaignRaw === CAMPAIGN_ID_MACRO) {
    tagKind = "ID_MACRO";
  } else if (utmContentRaw === AD_NAME_MACRO || utmCampaignRaw === CAMPAIGN_NAME_MACRO) {
    tagKind = "NAME_MACRO";
  } else if (utmContentRaw !== null || utmCampaignRaw !== null) {
    tagKind = "STATIC_TEXT";
  } else {
    tagKind = "MISSING";
  }

  return {
    adId,
    destinationUrl,
    utmContentRaw,
    utmCampaignRaw,
    tagKind,
    resolvable: tagKind === "ID_MACRO",
  };
}

/** Ad statuses excluded from "live" for this audit — everything else (ACTIVE, PAUSED, and any
 * status this account's Meta API version returns that isn't one of these two) is audited. A
 * DELETED/ARCHIVED ad can never serve again, so its tag configuration is moot; a PAUSED ad is
 * still "live" here because it can be turned back on without ever passing through this audit
 * again first. */
const NOT_LIVE_STATUSES = new Set(["DELETED", "ARCHIVED"]);

export interface RunUrlTagAuditResult {
  adsAudited: number;
  adsSkippedNotLive: number;
  resolvable: number;
  unresolvable: number;
  byTagKind: Record<AdUrlTagKind, number>;
  /** Bounded so a large unresolvable set never blows up a task's summary payload — the
   * persisted `adUrlTagAudits` collection (queryable by `resolvable === false`) is the real,
   * complete source of truth for the UI; this is a debugging convenience only. */
  unresolvableAdIdsSample: string[];
}

const UNRESOLVABLE_SAMPLE_LIMIT = 50;

/**
 * Reads every non-deleted/archived `metaAds` document, audits its `destinationUrl`, and
 * wholesale-overwrites `adUrlTagAudits/{adId}` with the result — current state only (see
 * shared/schema/meta.ts's module comment on adUrlTagAuditSchema for why this collection isn't
 * version-guarded or snapshotted).
 */
export async function runUrlTagAudit(
  db: Firestore,
  now: () => Date = () => new Date(),
): Promise<RunUrlTagAuditResult> {
  const adsRef = collectionRef(db, COLLECTIONS.metaAds, metaAdSchema);
  const adsSnap = await adsRef.get();
  const allAds = adsSnap.docs.map((d) => d.data());

  const liveAds = allAds.filter((ad) => !NOT_LIVE_STATUSES.has(ad.status));
  const auditRepo = createRepository(db, COLLECTIONS.adUrlTagAudits, adUrlTagAuditSchema);

  const byTagKind: Record<AdUrlTagKind, number> = {
    ID_MACRO: 0,
    NAME_MACRO: 0,
    STATIC_TEXT: 0,
    MISSING: 0,
    NO_URL: 0,
  };
  let resolvable = 0;
  const unresolvableAdIdsSample: string[] = [];
  const auditedAt = now();

  for (const ad of liveAds) {
    const result = auditAdDestinationUrl(ad.adId, ad.destinationUrl);
    byTagKind[result.tagKind]++;
    if (result.resolvable) {
      resolvable++;
    } else if (unresolvableAdIdsSample.length < UNRESOLVABLE_SAMPLE_LIMIT) {
      unresolvableAdIdsSample.push(ad.adId);
    }

    await auditRepo.set(ad.adId, {
      adId: ad.adId,
      auditedAt,
      destinationUrl: result.destinationUrl,
      utmContentRaw: result.utmContentRaw,
      utmCampaignRaw: result.utmCampaignRaw,
      tagKind: result.tagKind,
      resolvable: result.resolvable,
    });
  }

  return {
    adsAudited: liveAds.length,
    adsSkippedNotLive: allAds.length - liveAds.length,
    resolvable,
    unresolvable: liveAds.length - resolvable,
    byTagKind,
    unresolvableAdIdsSample,
  };
}

// ---------------------------------------------------------------------------------------
// AUDIT_AD_URL_TAGS task registration. No Meta/Shopify client used — this operates entirely on
// B2's already-ingested `metaAds.destinationUrl` in Firestore, not a fresh live Meta fetch (see
// module comment). `runSource: "internal"` reflects that: it's a derived-data audit, not a sync
// against an external source, so it has no `syncState` watermark of its own.
// ---------------------------------------------------------------------------------------

export const auditAdUrlTagsHandler: TaskHandler = async () => {
  const db = getDb();
  const result = await runUrlTagAudit(db);
  return {
    newRowCount: result.adsAudited,
    summary: {
      adsAudited: result.adsAudited,
      adsSkippedNotLive: result.adsSkippedNotLive,
      resolvable: result.resolvable,
      unresolvable: result.unresolvable,
      byTagKind: result.byTagKind,
      unresolvableAdIdsSample: result.unresolvableAdIdsSample,
    },
  };
};

export const auditAdUrlTagsRegistration: TaskRegistration = {
  taskType: "AUDIT_AD_URL_TAGS",
  runSource: "internal",
  syncStateTarget: null,
  handler: auditAdUrlTagsHandler,
};
