// UTM parsing — §6.1's join: "Shopify orders are attributed to Meta ads by parsing UTM
// parameters from the order's `landing_site`."
//
// Pure, no Firestore/network — parses a raw `landingSite`/`referringSite`-shaped string (a
// relative path+query, a bare query string, or a full URL — B5's two sources, Matrixify's CSV
// and the (dead-end, see B7's Notes) GraphQL path, don't guarantee which shape arrives) into its
// UTM parameters, plus `fbclid` (Open Question #1: 97/10,001 orders carry only this, opaque and
// unresolvable without the Conversions API — captured here so it's at least visible, never
// silently dropped).
//
// `normalizeUtmSource` exists because Open Question #1 found the live `utm_source` value
// spelled four different ways across real orders: `meta`, `roi_meta`, `facebook`, `RM_META`. The
// resolver (resolveOrder.ts) uses this to decide whether an order even claims to be Meta
// traffic before attempting an ad/campaign match — an order tagged `utm_source=google` should
// never be resolved against a Meta ad merely because its `utm_content` happens to collide with
// one.

/** Known-live spellings of "this is Meta traffic" (Open Question #1's measured findings),
 * matched case-insensitively after trimming. Not exhaustive by construction — a real account's
 * tagging is inconsistent, and this list should grow if AUDIT_AD_URL_TAGS or the join itself
 * turns up another variant. `roi_meta`/`RM_META` are almost certainly this account's tool
 * (name suggests an ROI/attribution app prefixing its own tag) rather than a Meta-standard
 * value — kept because they were observed live, not because they're canonical. */
const KNOWN_META_UTM_SOURCE_VALUES = new Set(["meta", "roi_meta", "facebook", "rm_meta"]);

export type NormalizedUtmSource = "meta" | "other" | null;

/** `null` = no `utm_source` present at all. `"other"` covers everything present but not a
 * recognized Meta spelling (including empty-string). Never throws. */
export function normalizeUtmSource(raw: string | null | undefined): NormalizedUtmSource {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return KNOWN_META_UTM_SOURCE_VALUES.has(trimmed.toLowerCase()) ? "meta" : "other";
}

export interface ParsedAttributionTag {
  /** The query string actually parsed, verbatim (no leading `?`) — this is what B7's spec
   * means by "raw tag string stored alongside the resolved ID": everything needed to redo this
   * parse from the archive without re-fetching from Shopify. Empty string if the input had no
   * query component at all (still distinct from `null` — `null` means no landingSite at all). */
  rawQueryString: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  fbclid: string | null;
  normalizedSource: NormalizedUtmSource;
}

/**
 * Parses a `landingSite`-shaped string into its UTM parameters. Returns `null` only when
 * `landingSite` itself is `null`/empty — a landingSite with no query string at all still
 * produces a `ParsedAttributionTag` with every param `null` and `rawQueryString: ""`, which
 * matters: it's a genuine "we saw this order's landing page and it carried no tag", distinct
 * from "we never captured a landing page for this order."
 *
 * Robust to both a relative path+query (`/products/x?utm_source=meta`) and a full URL
 * (`https://shop.example.com/products/x?utm_source=meta`) — both of B5's real sources
 * (Matrixify's `Browser: Landing Page` column) can contain either shape. Falls back to a naive
 * `?`-split if `URL` parsing throws on a malformed value rather than losing the row.
 */
export function parseAttributionTag(
  landingSite: string | null | undefined,
): ParsedAttributionTag | null {
  if (landingSite === null || landingSite === undefined) return null;
  if (landingSite.trim().length === 0) return null;

  const queryString = extractQueryString(landingSite);
  const params = new URLSearchParams(queryString);

  const utmSource = params.get("utm_source");
  return {
    rawQueryString: queryString,
    utmSource,
    utmMedium: params.get("utm_medium"),
    utmCampaign: params.get("utm_campaign"),
    utmContent: params.get("utm_content"),
    fbclid: params.get("fbclid"),
    normalizedSource: normalizeUtmSource(utmSource),
  };
}

function extractQueryString(raw: string): string {
  try {
    const parsed = new URL(raw, "https://placeholder.invalid");
    return parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search;
  } catch {
    // Malformed URL/path (e.g. an unencoded space) — fall back to a naive split rather than
    // discarding whatever query-shaped tail the string has.
    const qIndex = raw.indexOf("?");
    return qIndex === -1 ? "" : raw.slice(qIndex + 1);
  }
}
