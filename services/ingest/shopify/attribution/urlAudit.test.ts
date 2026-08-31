import { describe, expect, it } from "vitest";
import { auditAdDestinationUrl } from "./urlAudit.ts";

describe("auditAdDestinationUrl", () => {
  it("ID_MACRO — utm_content={{ad.id}} is resolvable", () => {
    const result = auditAdDestinationUrl(
      "123",
      "https://sparkleandglow.co.in/products/x?utm_source=meta&utm_content={{ad.id}}",
    );
    expect(result.tagKind).toBe("ID_MACRO");
    expect(result.resolvable).toBe(true);
  });

  it("ID_MACRO — utm_campaign={{campaign.id}} alone is also resolvable", () => {
    const result = auditAdDestinationUrl(
      "123",
      "https://sparkleandglow.co.in/products/x?utm_source=meta&utm_campaign={{campaign.id}}",
    );
    expect(result.tagKind).toBe("ID_MACRO");
    expect(result.resolvable).toBe(true);
  });

  it("NAME_MACRO — utm_content={{ad.name}} is not directly resolvable", () => {
    const result = auditAdDestinationUrl(
      "123",
      "https://sparkleandglow.co.in/products/x?utm_content={{ad.name}}",
    );
    expect(result.tagKind).toBe("NAME_MACRO");
    expect(result.resolvable).toBe(false);
  });

  it("STATIC_TEXT — Open Question #1's real, dominant case: a literal human name, no macro at all", () => {
    const result = auditAdDestinationUrl(
      "123",
      "https://sparkleandglow.co.in/products/x?utm_source=meta&utm_content=RM_Instagram",
    );
    expect(result.tagKind).toBe("STATIC_TEXT");
    expect(result.resolvable).toBe(false);
    expect(result.utmContentRaw).toBe("RM_Instagram");
  });

  it("MISSING — a real URL with no utm_content/utm_campaign at all", () => {
    const result = auditAdDestinationUrl("123", "https://sparkleandglow.co.in/products/x");
    expect(result.tagKind).toBe("MISSING");
    expect(result.resolvable).toBe(false);
  });

  it("NO_URL — the ad has no destination URL captured at all", () => {
    expect(auditAdDestinationUrl("123", null)).toEqual({
      adId: "123",
      destinationUrl: null,
      utmContentRaw: null,
      utmCampaignRaw: null,
      tagKind: "NO_URL",
      resolvable: false,
    });
  });
});
