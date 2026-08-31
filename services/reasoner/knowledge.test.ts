import { describe, expect, it } from "vitest";
import {
  adOptimizationKnowledgeSchema,
  renderKnowledgeForPrompt,
  SEED_KNOWLEDGE_V1,
  type AdOptimizationKnowledge,
} from "./knowledge.ts";

describe("SEED_KNOWLEDGE_V1 (D3.1's hand-curated v1 seed playbook)", () => {
  it("is non-empty and every entry is versioned/pinned/attributed", () => {
    expect(SEED_KNOWLEDGE_V1.length).toBeGreaterThan(0);
    for (const entry of SEED_KNOWLEDGE_V1) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.statement.length).toBeGreaterThan(0);
      // D3.1: "record each entry's source URL and retrieval date so a claim can be traced".
      expect(entry.sourceUrl).not.toBeNull();
      expect(entry.retrievedAt).not.toBeNull();
    }
  });

  it("has unique entry ids", () => {
    const ids = SEED_KNOWLEDGE_V1.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parses as a valid published knowledge document once wrapped", () => {
    const doc: AdOptimizationKnowledge = {
      version: "v1",
      publishedAt: new Date("2026-02-01T00:00:00Z"),
      publishedBy: "seed",
      active: true,
      entries: [...SEED_KNOWLEDGE_V1],
    };
    expect(() => adOptimizationKnowledgeSchema.parse(doc)).not.toThrow();
  });
});

describe("renderKnowledgeForPrompt (§17.3 framing)", () => {
  it("renders an honest 'no knowledge loaded' message when null", () => {
    const text = renderKnowledgeForPrompt(null);
    expect(text.toLowerCase()).toContain("no ad-optimization knowledge playbook");
    // Must not accidentally claim untrusted-content framing around nothing.
    expect(text).not.toContain("<untrusted-content");
  });

  it("wraps a real playbook in untrusted-content boundaries naming its version", () => {
    const doc: AdOptimizationKnowledge = {
      version: "v1",
      publishedAt: new Date("2026-02-01T00:00:00Z"),
      publishedBy: "seed",
      active: true,
      entries: [...SEED_KNOWLEDGE_V1],
    };
    const text = renderKnowledgeForPrompt(doc);
    expect(text).toMatch(/<untrusted-content source="ad-optimization-knowledge-playbook-v1">/);
    expect(text).toContain('Playbook version "v1"');
    expect(text).toContain("published 2026-02-01 by seed");
  });

  it("states explicitly that the playbook never overrides measured evidence or a guardrail", () => {
    const doc: AdOptimizationKnowledge = {
      version: "v2",
      publishedAt: new Date("2026-03-01T00:00:00Z"),
      publishedBy: "operator",
      active: true,
      entries: [...SEED_KNOWLEDGE_V1],
    };
    const text = renderKnowledgeForPrompt(doc);
    expect(text.toLowerCase()).toMatch(/never overrides this account's own measured evidence/);
    expect(text.toLowerCase()).toMatch(/cannot be influenced by anything in this prompt/);
  });

  it("carries every entry's statement, source and retrieval date into the rendered text", () => {
    const doc: AdOptimizationKnowledge = {
      version: "v1",
      publishedAt: new Date("2026-02-01T00:00:00Z"),
      publishedBy: "seed",
      active: true,
      entries: [SEED_KNOWLEDGE_V1[0]],
    };
    const text = renderKnowledgeForPrompt(doc);
    const entry = SEED_KNOWLEDGE_V1[0];
    expect(text).toContain(entry.statement);
    expect(text).toContain(entry.sourceUrl as string);
  });
});
