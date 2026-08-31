import { describe, expect, it } from "vitest";
import type { MetaCreative } from "@shared/schema/index.ts";
import {
  buildCreativeIdentity,
  clusterAssetsByPerceptualHash,
  compositeFamilyId,
} from "./identity.ts";

function creative(overrides: Partial<MetaCreative> & { creativeId: string }): MetaCreative {
  return {
    accountId: "act_1",
    name: null,
    imageHash: null,
    videoId: null,
    creativeType: "STANDARD",
    memberAssetHashes: null,
    deliveredMixObservable: null,
    bodyText: null,
    headline: null,
    linkUrl: null,
    syncedAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

describe("buildCreativeIdentity", () => {
  it("groups two ad creatives that share the same image_hash into one family", () => {
    const creatives = [
      creative({ creativeId: "cr_1", imageHash: "hash_a", headline: "Headline A" }),
      creative({ creativeId: "cr_2", imageHash: "hash_a", headline: "Headline B (same image)" }),
    ];
    const { assets, families } = buildCreativeIdentity(creatives);

    expect(assets).toHaveLength(1);
    expect(assets[0]?.assetHash).toBe("hash_a");
    expect(assets[0]?.sourceType).toBe("IMAGE");

    expect(families).toHaveLength(1);
    expect(families[0]?.creativeType).toBe("STANDARD");
    expect(families[0]?.eligibleForFamilyFatigueScore).toBe(true);
    expect(families[0]?.variationCount).toBe(2); // two distinct ad-creative objects, one asset
    expect(families[0]?.memberAssetHashes).toEqual(["hash_a"]);
    expect(assets[0]?.familyId).toBe(families[0]?.familyId);
  });

  it("groups a video creative by video_id, separately from image-hash creatives", () => {
    const creatives = [
      creative({ creativeId: "cr_img", imageHash: "hash_a" }),
      creative({ creativeId: "cr_vid", videoId: "vid_1" }),
    ];
    const { assets, families } = buildCreativeIdentity(creatives);

    expect(assets).toHaveLength(2);
    const video = assets.find((a) => a.assetHash === "vid_1");
    expect(video?.sourceType).toBe("VIDEO");
    expect(families).toHaveLength(2); // no perceptual-hash data yet -> no cross-hash merging
  });

  it("picks the representative copy from the most recently synced member, tie-broken by creativeId", () => {
    const creatives = [
      creative({
        creativeId: "cr_old",
        imageHash: "hash_a",
        headline: "Old headline",
        syncedAt: new Date("2026-01-01T00:00:00Z"),
      }),
      creative({
        creativeId: "cr_new",
        imageHash: "hash_a",
        headline: "New headline",
        syncedAt: new Date("2026-08-01T00:00:00Z"),
      }),
    ];
    const { assets } = buildCreativeIdentity(creatives);
    expect(assets[0]?.copy?.headline).toBe("New headline");
  });

  it("types a composite creative explicitly, excludes it from fatigue eligibility, and gives it no creativeAssets entry", () => {
    const creatives = [
      creative({
        creativeId: "cr_dco",
        creativeType: "COMPOSITE",
        memberAssetHashes: ["a1b2", "c3d4", "e5f6"],
        deliveredMixObservable: false,
      }),
    ];
    const { assets, families } = buildCreativeIdentity(creatives);

    expect(assets).toHaveLength(0); // composites don't get a single-hash asset identity
    expect(families).toHaveLength(1);
    const family = families[0];
    expect(family?.familyId).toBe(compositeFamilyId("cr_dco"));
    expect(family?.creativeType).toBe("COMPOSITE");
    expect(family?.eligibleForFamilyFatigueScore).toBe(false);
    expect(family?.fatigueScore).toBeNull();
    expect(family?.memberAssetHashes).toEqual(["a1b2", "c3d4", "e5f6"]);
    expect(family?.variationCount).toBe(3);
  });

  it("gives each composite its own family — v1 attempts no cross-composite merging", () => {
    const creatives = [
      creative({ creativeId: "cr_dco_1", creativeType: "COMPOSITE", memberAssetHashes: ["a1"] }),
      creative({ creativeId: "cr_dco_2", creativeType: "COMPOSITE", memberAssetHashes: ["a1"] }),
    ];
    const { families } = buildCreativeIdentity(creatives);
    expect(families).toHaveLength(2);
    expect(new Set(families.map((f) => f.familyId)).size).toBe(2);
  });

  it("surfaces a STANDARD creative with neither image_hash nor video_id as unidentifiable, not fabricated into a family", () => {
    const creatives = [creative({ creativeId: "cr_bare" })];
    const { assets, families, unidentifiableCreativeIds } = buildCreativeIdentity(creatives);
    expect(assets).toHaveLength(0);
    expect(families).toHaveLength(0);
    expect(unidentifiableCreativeIds).toEqual(["cr_bare"]);
  });

  it("preserves discoveredAt/createdAt across a re-run when the caller supplies existing values", () => {
    const originalDiscoveredAt = new Date("2026-01-15T00:00:00Z");
    const creatives = [creative({ creativeId: "cr_1", imageHash: "hash_a" })];
    const rerunNow = new Date("2026-08-30T00:00:00Z");

    const { assets, families } = buildCreativeIdentity(creatives, {
      now: rerunNow,
      existingAssetDiscoveredAt: new Map([["hash_a", originalDiscoveredAt]]),
      existingFamilyCreatedAt: new Map([["hash_a", originalDiscoveredAt]]),
    });

    expect(assets[0]?.discoveredAt).toEqual(originalDiscoveredAt);
    expect(families[0]?.createdAt).toEqual(originalDiscoveredAt);
    expect(families[0]?.updatedAt).toEqual(rerunNow); // updatedAt still bumps every run
  });

  it("defaults discoveredAt/createdAt to `now` for a hash never seen before", () => {
    const now = new Date("2026-08-30T00:00:00Z");
    const creatives = [creative({ creativeId: "cr_1", imageHash: "hash_new" })];
    const { assets, families } = buildCreativeIdentity(creatives, { now });
    expect(assets[0]?.discoveredAt).toEqual(now);
    expect(families[0]?.createdAt).toEqual(now);
  });

  it("raises sample size by pooling ads across multiple ad-creative objects sharing one asset (§4.1)", () => {
    // Simulates the real-account shape: many `metaCreatives` docs (one per ad-creative object,
    // possibly reused by several ads) collapsing onto far fewer distinct assets/families.
    const creatives = Array.from({ length: 20 }, (_, i) =>
      creative({ creativeId: `cr_${i}`, imageHash: "hash_popular" }),
    );
    const { assets, families } = buildCreativeIdentity(creatives);
    expect(assets).toHaveLength(1);
    expect(families).toHaveLength(1);
    expect(families[0]?.variationCount).toBe(20);
  });
});

describe("clusterAssetsByPerceptualHash", () => {
  it("keeps every asset a singleton cluster when every perceptual hash is null (the v1 reality)", () => {
    const result = clusterAssetsByPerceptualHash(
      new Map([
        ["hash_a", null],
        ["hash_b", null],
      ]),
      10,
    );
    expect(result.get("hash_a")).toBe("hash_a");
    expect(result.get("hash_b")).toBe("hash_b");
  });

  it("merges two hashes within the Hamming-distance threshold (synthetic near-duplicate proof)", () => {
    // "0000" vs "0001" differ by 1 bit in the last hex digit.
    const result = clusterAssetsByPerceptualHash(
      new Map([
        ["hash_a", "0000"],
        ["hash_b", "0001"],
      ]),
      2,
    );
    expect(result.get("hash_a")).toBe(result.get("hash_b"));
  });

  it("does not merge two hashes beyond the threshold", () => {
    // "0000" vs "ffff" differ in every bit.
    const result = clusterAssetsByPerceptualHash(
      new Map([
        ["hash_a", "0000"],
        ["hash_b", "ffff"],
      ]),
      2,
    );
    expect(result.get("hash_a")).not.toBe(result.get("hash_b"));
  });

  it("transitively merges a chain of near-duplicates into one cluster", () => {
    const result = clusterAssetsByPerceptualHash(
      new Map([
        ["hash_a", "0000"],
        ["hash_b", "0001"], // within 1 bit of a
        ["hash_c", "0011"], // within 1 bit of b, but 2 bits from a directly
      ]),
      1,
    );
    const clusterA = result.get("hash_a");
    expect(result.get("hash_b")).toBe(clusterA);
    expect(result.get("hash_c")).toBe(clusterA);
  });

  it("picks the lexicographically smallest hash in a cluster as the canonical id, deterministically", () => {
    const result = clusterAssetsByPerceptualHash(
      new Map([
        ["hash_z", "0000"],
        ["hash_a", "0001"],
      ]),
      2,
    );
    expect(result.get("hash_z")).toBe("hash_a");
    expect(result.get("hash_a")).toBe("hash_a");
  });
});
