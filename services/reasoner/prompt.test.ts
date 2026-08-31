import { describe, expect, it } from "vitest";
import { TEST_CANON } from "../ingest/meta/entities/testFixtures.ts";
import {
  buildAccountContextText,
  buildSystemBlocks,
  buildUserContentBlocks,
  STABLE_SYSTEM_TEXT,
} from "./prompt.ts";
import { SEED_KNOWLEDGE_V1, type AdOptimizationKnowledge } from "./knowledge.ts";

const KNOWLEDGE: AdOptimizationKnowledge = {
  version: "v1",
  publishedAt: new Date("2026-02-01T00:00:00Z"),
  publishedBy: "seed",
  active: true,
  entries: [...SEED_KNOWLEDGE_V1],
};

describe("§19.3 caching order — tools -> system -> account context -> packet, volatile last", () => {
  it("buildSystemBlocks: ground rules first, then knowledge; cache_control ONLY on the last block", () => {
    const blocks = buildSystemBlocks(KNOWLEDGE);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe(STABLE_SYSTEM_TEXT);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("buildSystemBlocks with no knowledge still renders an honest placeholder, still cached", () => {
    const blocks = buildSystemBlocks(null);
    expect(blocks[1].text.toLowerCase()).toContain("no ad-optimization knowledge playbook");
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("buildUserContentBlocks: account context (cached) THEN packet text (volatile, LAST, uncached)", () => {
    const blocks = buildUserContentBlocks(TEST_CANON, "PACKET TEXT GOES HERE");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[1].text).toContain("PACKET TEXT GOES HERE");
    // The packet block must be the LAST block in the array — nothing volatile precedes it.
    expect(blocks[blocks.length - 1].text).toContain("PACKET TEXT GOES HERE");
  });

  it("account context never appears after the packet text", () => {
    const blocks = buildUserContentBlocks(TEST_CANON, "UNIQUE_PACKET_MARKER_42");
    const accountIndex = blocks.findIndex((b) => b.text.includes("ACCOUNT CONTEXT"));
    const packetIndex = blocks.findIndex((b) => b.text.includes("UNIQUE_PACKET_MARKER_42"));
    expect(accountIndex).toBeGreaterThanOrEqual(0);
    expect(packetIndex).toBeGreaterThan(accountIndex);
  });
});

describe("no silent cache invalidators", () => {
  it("STABLE_SYSTEM_TEXT is a plain constant — never calls Date/Math.random", () => {
    expect(STABLE_SYSTEM_TEXT).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // no embedded ISO timestamp
  });

  it("buildAccountContextText is a pure function of CanonSettings — identical output for identical input", () => {
    const a = buildAccountContextText(TEST_CANON);
    const b = buildAccountContextText(TEST_CANON);
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("buildSystemBlocks is deterministic across repeated calls with the same knowledge doc", () => {
    const first = buildSystemBlocks(KNOWLEDGE);
    const second = buildSystemBlocks(KNOWLEDGE);
    expect(first).toEqual(second);
  });
});

describe("buildAccountContextText — honesty about placeholders (§0.2/reality #6)", () => {
  it("flags a placeholder-default target explicitly when no operator override exists", () => {
    const text = buildAccountContextText(TEST_CANON); // TEST_CANON has no statisticalThresholds
    expect(text).toMatch(/BUILT-IN PLACEHOLDER defaults/);
  });

  it("credits the operator's own configured thresholds when they exist", () => {
    const withThresholds = {
      ...TEST_CANON,
      statisticalThresholds: {
        minPurchaseFloors: { "7d": 12, "14d": 20, "28d": 30, "56d": 45 },
        targetRoas: 4.2,
        targetCpaMinorUnits: 120_000,
        intervalZScore: 1.645,
      },
    };
    const text = buildAccountContextText(withThresholds);
    expect(text).toMatch(/operator's own configured statistical thresholds/);
    expect(text).toContain("4.2");
  });

  it("states the near-zero Shopify attribution coverage as a standing fact", () => {
    const text = buildAccountContextText(TEST_CANON);
    expect(text).toMatch(/0\.02%/);
  });
});
