import { describe, expect, it } from "vitest";
import { normalizeUtmSource, parseAttributionTag } from "./utmTag.ts";

describe("normalizeUtmSource", () => {
  it("recognizes Open Question #1's measured live spellings, case-insensitively", () => {
    expect(normalizeUtmSource("meta")).toBe("meta");
    expect(normalizeUtmSource("roi_meta")).toBe("meta");
    expect(normalizeUtmSource("facebook")).toBe("meta");
    expect(normalizeUtmSource("RM_META")).toBe("meta");
    expect(normalizeUtmSource("Facebook")).toBe("meta");
    expect(normalizeUtmSource("  meta  ")).toBe("meta");
  });

  it("returns 'other' for a present-but-unrecognized source", () => {
    expect(normalizeUtmSource("google")).toBe("other");
    expect(normalizeUtmSource("newsletter")).toBe("other");
  });

  it("returns null for absent/empty", () => {
    expect(normalizeUtmSource(null)).toBeNull();
    expect(normalizeUtmSource(undefined)).toBeNull();
    expect(normalizeUtmSource("")).toBeNull();
    expect(normalizeUtmSource("   ")).toBeNull();
  });
});

describe("parseAttributionTag", () => {
  it("returns null for a null/empty landingSite — distinct from 'no query string'", () => {
    expect(parseAttributionTag(null)).toBeNull();
    expect(parseAttributionTag(undefined)).toBeNull();
    expect(parseAttributionTag("")).toBeNull();
    expect(parseAttributionTag("   ")).toBeNull();
  });

  it("parses a relative path+query landingSite", () => {
    const result = parseAttributionTag(
      "/products/temple-set?utm_source=meta&utm_medium=paid&utm_campaign=120210000000001&utm_content=120210000000003",
    );
    expect(result).toEqual({
      rawQueryString:
        "utm_source=meta&utm_medium=paid&utm_campaign=120210000000001&utm_content=120210000000003",
      utmSource: "meta",
      utmMedium: "paid",
      utmCampaign: "120210000000001",
      utmContent: "120210000000003",
      fbclid: null,
      normalizedSource: "meta",
    });
  });

  it("parses a full absolute URL landingSite the same way", () => {
    const result = parseAttributionTag(
      "https://shopsparkleandglow.myshopify.com/products/x?utm_source=facebook&utm_content=RM_Instagram",
    );
    expect(result?.utmSource).toBe("facebook");
    expect(result?.utmContent).toBe("RM_Instagram");
    expect(result?.normalizedSource).toBe("meta");
  });

  it("captures fbclid even with no utm_source at all (Open Question #1: 97 orders)", () => {
    const result = parseAttributionTag("/products/x?fbclid=IwAR123abc");
    expect(result?.fbclid).toBe("IwAR123abc");
    expect(result?.utmSource).toBeNull();
    expect(result?.normalizedSource).toBeNull();
  });

  it("a landingSite with a path but no query string still parses, with every param null", () => {
    const result = parseAttributionTag("/products/x");
    expect(result).toEqual({
      rawQueryString: "",
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmContent: null,
      fbclid: null,
      normalizedSource: null,
    });
  });

  it("falls back to a naive split rather than throwing on a malformed value", () => {
    // An unencoded space breaks strict URL parsing; the naive-split fallback should still find
    // the query string.
    const result = parseAttributionTag("/products/my product?utm_source=meta&utm_content=42");
    expect(result?.utmSource).toBe("meta");
    expect(result?.utmContent).toBe("42");
  });

  it("URL-decodes parameter values", () => {
    const result = parseAttributionTag("/x?utm_content=Navratri%20sale%2015%25%20OFF%7C%20AD");
    expect(result?.utmContent).toBe("Navratri sale 15% OFF| AD");
  });
});
