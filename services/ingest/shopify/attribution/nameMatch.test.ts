import { describe, expect, it } from "vitest";
import { buildNameIndex, lookupByName, normalizeEntityName } from "./nameMatch.ts";

describe("normalizeEntityName", () => {
  it("trims, collapses internal whitespace, lowercases", () => {
    expect(normalizeEntityName("  RM_Instagram  ")).toBe("rm_instagram");
    expect(normalizeEntityName("New   Sales    Ad Set")).toBe("new sales ad set");
    expect(normalizeEntityName("Navratri sale 15% OFF| AD")).toBe("navratri sale 15% off| ad");
  });
});

describe("buildNameIndex / lookupByName", () => {
  interface Ad {
    adId: string;
    name: string;
  }
  const ads: Ad[] = [
    { adId: "1", name: "RM_Instagram" },
    { adId: "2", name: "RM_Instagram" }, // same name, different ad — real collision case
    { adId: "3", name: "New Sales Ad Set" },
    { adId: "4", name: "" }, // an empty name must never be a matchable bucket
  ];
  const index = buildNameIndex(ads, (a) => a.name);

  it("a unique name resolves to exactly that entity", () => {
    const result = lookupByName(index, "New Sales Ad Set");
    expect(result).toEqual({ kind: "unique", entity: { adId: "3", name: "New Sales Ad Set" } });
  });

  it("lookup is case/whitespace-insensitive", () => {
    const result = lookupByName(index, "  new sales ad set ");
    expect(result.kind).toBe("unique");
  });

  it("a name shared by two entities is reported ambiguous, never picked", () => {
    const result = lookupByName(index, "RM_Instagram");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((c) => c.adId).sort()).toEqual(["1", "2"]);
    }
  });

  it("no-match for an unrelated string", () => {
    expect(lookupByName(index, "Something Else Entirely")).toEqual({ kind: "no-match" });
  });

  it("no-match for null or empty input", () => {
    expect(lookupByName(index, null)).toEqual({ kind: "no-match" });
    expect(lookupByName(index, "")).toEqual({ kind: "no-match" });
    expect(lookupByName(index, "   ")).toEqual({ kind: "no-match" });
  });

  it("an empty entity name is never indexed as a matchable bucket", () => {
    expect(lookupByName(index, "")).toEqual({ kind: "no-match" });
  });
});
