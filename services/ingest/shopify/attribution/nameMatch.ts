// Name normalization and ambiguity-aware lookup for the §6.1 name-matching fallback.
//
// ⚠️ Ad names are neither unique nor stable over time (B7 spec, verbatim). Two live entities
// can share a normalized name — a rename can produce a collision, or an advertiser can simply
// reuse a naming pattern ("Retarget - 7d" on two different ad sets in two different campaigns).
// `NameIndex` therefore maps a normalized name to an ARRAY of candidates, never a single one —
// collapsing that array down to "pick one" is exactly the mistake the spec says not to make.
// Callers (resolveOrder.ts) must treat `candidates.length > 1` as ambiguous and refuse to
// resolve, not take `candidates[0]`.

export type NormalizedName = string;

/** Trim, collapse internal whitespace, lowercase. Deliberately simple — this is matching
 * against real entity names typed by a human into Meta's UTM-parameter field (Open Question #1's
 * examples: `RM_Instagram`, `New Sales Ad Set`, `RM_CBO_Remarketing_Campaign`,
 * `"Navratri sale 15% OFF| AD"`), not free-text search. No stemming, no punctuation-stripping —
 * those would only manufacture false-positive collisions between genuinely different ads, which
 * is the one failure mode this whole fallback is designed to avoid, not invite. */
export function normalizeEntityName(name: string): NormalizedName {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface NameIndexEntry<T> {
  normalizedName: NormalizedName;
  candidates: T[];
}

/** Builds a normalized-name → candidates[] index from a list of entities. Multiple entities
 * normalizing to the same name land in the same bucket — that's the ambiguity signal, not a bug
 * to dedupe away. */
export function buildNameIndex<T>(
  entities: readonly T[],
  getName: (entity: T) => string,
): Map<NormalizedName, T[]> {
  const index = new Map<NormalizedName, T[]>();
  for (const entity of entities) {
    const key = normalizeEntityName(getName(entity));
    if (key.length === 0) continue; // an empty/whitespace-only name can never be a real tag match
    const bucket = index.get(key);
    if (bucket) bucket.push(entity);
    else index.set(key, [entity]);
  }
  return index;
}

export type NameLookupResult<T> =
  { kind: "no-match" } | { kind: "unique"; entity: T } | { kind: "ambiguous"; candidates: T[] };

/** Looks up a raw (unnormalized) tag value against a name index. `null`/empty input is always
 * "no-match" — never throws. */
export function lookupByName<T>(
  index: ReadonlyMap<NormalizedName, T[]>,
  rawValue: string | null,
): NameLookupResult<T> {
  if (rawValue === null) return { kind: "no-match" };
  const key = normalizeEntityName(rawValue);
  if (key.length === 0) return { kind: "no-match" };
  const candidates = index.get(key);
  if (!candidates || candidates.length === 0) return { kind: "no-match" };
  return candidates.length === 1
    ? { kind: "unique", entity: candidates[0] }
    : { kind: "ambiguous", candidates };
}
