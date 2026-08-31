// B8 — Creative identity (§11.1, §7.3): the "cheap half" of creative work. Pure grouping logic,
// no Firestore, no network — `MetaCreative[]` (B2's own normalized output, already sitting in
// `metaCreatives`) in, `{ assets, families }` out. This module never re-derives what B2 already
// decided (composite detection, member asset hashes, image_hash/video_id extraction) — it only
// groups on top of it.
//
// ---------------------------------------------------------------------------------------------
// The perceptual-hash / out-of-scope tension, resolved explicitly (see IMPLEMENTATION_PLAN.md
// B8 notes for the full writeup):
//
// §11.1 asks for "Meta's own image_hash/video_id, plus a perceptual hash for near-duplicates."
// §11.2 (Phase F, explicitly out of scope for this step) is "Download -> Cloud Storage -> OCR /
// transcript -> ... -> embedding -> similarity search." A *real* perceptual hash (pHash/dHash/
// average-hash) requires decoding image pixel data, which requires either fetching the asset
// bytes (the "Download" step of §11.2) or an image-decoding library — and this step's safety
// constraints forbid adding any npm dependency, so even a narrowly-scoped thumbnail fetch
// couldn't be turned into a real hash here without hand-rolling a JPEG/PNG decoder, which is
// squarely the expensive half this step exists to avoid.
//
// Resolution: v1 groups by Meta's own image_hash/video_id equality only (exact-duplicate
// detection — Meta computes image_hash from the asset's own bytes, so two ad creatives that
// reuse the identical upload already collapse to one hash without any work on our part). The
// near-duplicate requirement is not silently dropped: `clusterAssetsByPerceptualHash` below is a
// complete, tested clustering algorithm (Hamming-distance union-find over the existing
// `creativeAssetSchema.perceptualHash` field) that runs on every build and IS the seam Phase F
// drops a real hash into — today it is a no-op (every `perceptualHash` is `null`, so every
// asset is its own singleton cluster), proven by identity.test.ts's synthetic-hash cases, which
// exercise real merging with fabricated (non-null) hashes to prove the algorithm itself works.
// Whoever builds Phase F's asset pipeline only needs to start populating `perceptualHash` on
// `creativeAssets` (post-download, post-decode) — this function does not change.
// ---------------------------------------------------------------------------------------------

import type { CreativeAsset, CreativeFamily } from "@shared/schema/index.ts";
import type { MetaCreative } from "@shared/schema/index.ts";

export interface BuildCreativeIdentityOptions {
  now?: Date;
  /** Max Hamming distance (in bits, comparing equal-length hex strings) for two non-null
   * perceptual hashes to be considered near-duplicates. Unused while every `perceptualHash` is
   * `null` (the v1 reality) — exercised only by identity.test.ts's synthetic cases. */
  hammingThreshold?: number;
  /** Preserve `discoveredAt` for an asset hash already seen in a previous run, keyed by
   * assetHash. Omit for a first-ever run (or a pure/no-Firestore call). */
  existingAssetDiscoveredAt?: Map<string, Date>;
  /** Preserve `createdAt` for a family already seen in a previous run, keyed by familyId. */
  existingFamilyCreatedAt?: Map<string, Date>;
}

export interface BuildCreativeIdentityResult {
  assets: CreativeAsset[];
  families: CreativeFamily[];
  /** STANDARD creatives with neither `imageHash` nor `videoId` — no honest asset hash to group
   * by. Not fabricated into a family; surfaced here so a caller can log/count them rather than
   * silently dropping them. Real-account rate reported in the B8 implementation notes. */
  unidentifiableCreativeIds: string[];
}

/** Union-find over hex-string hashes of equal length, merging any pair within
 * `hammingThreshold` bits. A `null` hash never merges with anything (including another `null`)
 * — it stays a singleton, which is the entire v1 behaviour until Phase F populates real hashes. */
export function clusterAssetsByPerceptualHash(
  hashesByAssetHash: Map<string, string | null>,
  hammingThreshold: number,
): Map<string, string> {
  // familyId assignment below is over the *cluster*, not this function's own concern — this
  // returns assetHash -> its cluster's canonical member (the lexicographically smallest hash in
  // the cluster), which the caller turns into a familyId.
  const assetHashes = [...hashesByAssetHash.keys()];
  const parent = new Map<string, string>(assetHashes.map((h) => [h, h]));

  function find(h: string): string {
    let root = h;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = h;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  function hammingDistance(a: string, b: string): number | null {
    if (a.length !== b.length) return null; // not directly comparable — never merge
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
      const na = parseInt(a[i] as string, 16);
      const nb = parseInt(b[i] as string, 16);
      if (Number.isNaN(na) || Number.isNaN(nb)) return null; // not hex — never merge
      distance += (na ^ nb).toString(2).split("1").length - 1;
    }
    return distance;
  }

  for (let i = 0; i < assetHashes.length; i++) {
    const hashA = hashesByAssetHash.get(assetHashes[i] as string);
    if (!hashA) continue; // null perceptual hash never merges
    for (let j = i + 1; j < assetHashes.length; j++) {
      const hashB = hashesByAssetHash.get(assetHashes[j] as string);
      if (!hashB) continue;
      const dist = hammingDistance(hashA, hashB);
      if (dist !== null && dist <= hammingThreshold) {
        union(assetHashes[i] as string, assetHashes[j] as string);
      }
    }
  }

  // Canonicalize each root to the lexicographically smallest member of its cluster, so the
  // result (and therefore the derived familyId) is deterministic regardless of iteration order.
  const clusterMembers = new Map<string, string[]>();
  for (const h of assetHashes) {
    const root = find(h);
    const members = clusterMembers.get(root) ?? [];
    members.push(h);
    clusterMembers.set(root, members);
  }
  const canonicalOf = new Map<string, string>();
  for (const members of clusterMembers.values()) {
    const canonical = [...members].sort()[0] as string;
    for (const m of members) canonicalOf.set(m, canonical);
  }

  const result = new Map<string, string>();
  for (const h of assetHashes) {
    result.set(h, canonicalOf.get(find(h)) as string);
  }
  return result;
}

const DEFAULT_HAMMING_THRESHOLD = 10;

/** `composite_{creativeId}` — a family id for a COMPOSITE metaCreative, one family per composite
 * (§7.3: "it has no single asset hash and cannot join a creative family cleanly" — v1 attempts
 * no cross-composite merging). Prefixed to keep it visibly distinct from a bare asset-hash
 * family id in the Firestore console / logs, even though the two id spaces cannot actually
 * collide (different collections). */
export function compositeFamilyId(creativeId: string): string {
  return `composite_${creativeId}`;
}

export function buildCreativeIdentity(
  creatives: MetaCreative[],
  options: BuildCreativeIdentityOptions = {},
): BuildCreativeIdentityResult {
  const now = options.now ?? new Date();
  const hammingThreshold = options.hammingThreshold ?? DEFAULT_HAMMING_THRESHOLD;
  const existingAssetDiscoveredAt = options.existingAssetDiscoveredAt ?? new Map<string, Date>();
  const existingFamilyCreatedAt = options.existingFamilyCreatedAt ?? new Map<string, Date>();

  const families: CreativeFamily[] = [];
  const unidentifiableCreativeIds: string[] = [];

  // --- Composites: one family per composite creative, no creativeAssets entry (§7.3). ---
  const compositeCreatives = creatives.filter((c) => c.creativeType === "COMPOSITE");
  for (const c of compositeCreatives) {
    const familyId = compositeFamilyId(c.creativeId);
    families.push({
      familyId,
      memberAssetHashes: c.memberAssetHashes ?? [],
      creativeType: "COMPOSITE",
      eligibleForFamilyFatigueScore: false,
      familyAgeDays: null,
      totalHistoricalSpendMinorUnits: null,
      activeAdsCount: null,
      // For a composite, "variations" is the count of member assets Meta is testing within this
      // one dynamic/Advantage+ creative — not a count of separate ad-creative objects, which
      // for a composite is always exactly 1 (itself).
      variationCount: c.memberAssetHashes?.length ?? 0,
      fatigueScore: null,
      createdAt: existingFamilyCreatedAt.get(familyId) ?? now,
      updatedAt: now,
    });
  }

  // --- Standard: group by Meta's own image_hash/video_id, then cluster by perceptual hash. ---
  const standardCreatives = creatives.filter((c) => c.creativeType === "STANDARD");
  const membersByAssetHash = new Map<string, MetaCreative[]>();
  for (const c of standardCreatives) {
    const assetHash = c.imageHash ?? c.videoId;
    if (!assetHash) {
      unidentifiableCreativeIds.push(c.creativeId);
      continue;
    }
    const members = membersByAssetHash.get(assetHash) ?? [];
    members.push(c);
    membersByAssetHash.set(assetHash, members);
  }

  // v1: every creativeAsset's perceptualHash is null (see module comment) — the seam is wired
  // through regardless, so it activates the moment Phase F starts populating real hashes.
  const perceptualHashByAssetHash = new Map<string, string | null>(
    [...membersByAssetHash.keys()].map((h) => [h, null]),
  );
  const clusterOf = clusterAssetsByPerceptualHash(perceptualHashByAssetHash, hammingThreshold);

  const assets: CreativeAsset[] = [];
  const familyIdByCluster = new Map<string, string>(); // canonical cluster member -> familyId
  const clusterMemberAssetHashes = new Map<string, Set<string>>();
  const clusterVariationCount = new Map<string, number>();

  for (const [assetHash, members] of membersByAssetHash) {
    const canonical = clusterOf.get(assetHash) as string;
    const familyId = canonical; // familyId == the cluster's canonical (smallest) assetHash
    familyIdByCluster.set(canonical, familyId);

    const hashes = clusterMemberAssetHashes.get(canonical) ?? new Set<string>();
    hashes.add(assetHash);
    clusterMemberAssetHashes.set(canonical, hashes);
    clusterVariationCount.set(
      canonical,
      (clusterVariationCount.get(canonical) ?? 0) + members.length,
    );

    // Representative copy: the most-recently-synced member creative, tie-broken by creativeId
    // for determinism. Copy is genuinely creative-level (attached to the ad-creative object,
    // not the underlying image) — multiple ad creatives sharing one image can carry different
    // copy — so this is a representative sample, not an authoritative "the" copy for the asset.
    const representative = [...members].sort((a, b) => {
      const t = b.syncedAt.getTime() - a.syncedAt.getTime();
      return t !== 0 ? t : a.creativeId.localeCompare(b.creativeId);
    })[0] as MetaCreative;

    assets.push({
      assetHash,
      sourceType: representative.imageHash ? "IMAGE" : "VIDEO",
      metaImageHash: representative.imageHash,
      metaVideoId: representative.videoId,
      perceptualHash: null, // Phase F populates this
      cloudStoragePath: null, // Phase F
      thumbnailUrl: null, // Phase F
      copy: {
        headline: representative.headline,
        body: representative.bodyText,
        description: null, // Meta's link_data has no separate description field B2 extracts
      },
      ocrText: null, // Phase F
      transcript: null, // Phase F
      structuredTags: null, // Phase F
      embedding: null, // Phase F
      familyId, // set below to the same value — kept here so an individual asset is self-describing
      analysisTimestamp: null,
      analysisModelVersion: null,
      discoveredAt: existingAssetDiscoveredAt.get(assetHash) ?? now,
    });
  }

  for (const [canonical, hashesSet] of clusterMemberAssetHashes) {
    const familyId = familyIdByCluster.get(canonical) as string;
    families.push({
      familyId,
      memberAssetHashes: [...hashesSet].sort(),
      creativeType: "STANDARD",
      eligibleForFamilyFatigueScore: true,
      familyAgeDays: null, // §11.3 metric — computed once C2 has spend/date context
      totalHistoricalSpendMinorUnits: null, // §11.3 metric — needs B3 insights join (C2)
      activeAdsCount: null, // §11.3 metric — needs metaAds join at feature-build time (C2)
      variationCount: clusterVariationCount.get(canonical) ?? 0,
      fatigueScore: null, // §11.3 metric — needs frequency/repetition features (C2/C3)
      createdAt: existingFamilyCreatedAt.get(familyId) ?? now,
      updatedAt: now,
    });
  }

  return { assets, families, unidentifiableCreativeIds };
}
