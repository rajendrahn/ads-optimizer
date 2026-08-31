// D3.1 — the Firestore-backed half of the knowledge layer: publishing (operator-triggered,
// never implicit), the "exactly one active version" invariant, and reproducibility (the same
// version loaded twice renders identically — required for E1's backtest to replay a past
// recommendation against the exact knowledge it saw).

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  adOptimizationKnowledgeSchema,
  loadActiveAdOptimizationKnowledge,
  refreshAdOptimizationKnowledge,
  renderKnowledgeForPrompt,
  SEED_KNOWLEDGE_V1,
  type AdOptimizationKnowledge,
} from "./knowledge.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "knowledge.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

async function cleanup() {
  const snaps = await db.collection(COLLECTIONS.adOptimizationKnowledge).listDocuments();
  await Promise.all(snaps.map((ref) => ref.delete()));
}
beforeEach(cleanup);
afterAll(cleanup);

describe("loadActiveAdOptimizationKnowledge — honest absence, never a hardcoded fallback", () => {
  it("returns null when nothing has ever been published", async () => {
    expect(await loadActiveAdOptimizationKnowledge(db)).toBeNull();
  });
});

describe("refreshAdOptimizationKnowledge — the operator-triggered publish path", () => {
  it("publishes v1 as the sole active version", async () => {
    const published = await refreshAdOptimizationKnowledge({
      db,
      version: "v1",
      publishedBy: "seed",
      entries: SEED_KNOWLEDGE_V1,
      now: new Date("2026-02-01T00:00:00Z"),
    });
    expect(published.active).toBe(true);

    const active = await loadActiveAdOptimizationKnowledge(db);
    expect(active?.version).toBe("v1");
    expect(active?.entries.length).toBe(SEED_KNOWLEDGE_V1.length);
  });

  it("publishing v2 deactivates v1 — exactly one active version at a time", async () => {
    await refreshAdOptimizationKnowledge({
      db,
      version: "v1",
      publishedBy: "seed",
      entries: SEED_KNOWLEDGE_V1,
    });
    await refreshAdOptimizationKnowledge({
      db,
      version: "v2",
      publishedBy: "operator",
      entries: [
        {
          id: "new-entry",
          category: "budget-pacing",
          statement: "An updated heuristic.",
          sourceUrl: "https://example.com/updated",
          retrievedAt: new Date("2026-03-01T00:00:00Z"),
        },
      ],
    });

    const v1Doc = await createRepository<AdOptimizationKnowledge>(
      db,
      COLLECTIONS.adOptimizationKnowledge,
      adOptimizationKnowledgeSchema,
    ).get("v1");
    expect(v1Doc?.active).toBe(false);

    const active = await loadActiveAdOptimizationKnowledge(db);
    expect(active?.version).toBe("v2");
  });

  it("throws rather than guessing when more than one version is (incorrectly) marked active", async () => {
    const repo = createRepository<AdOptimizationKnowledge>(
      db,
      COLLECTIONS.adOptimizationKnowledge,
      adOptimizationKnowledgeSchema,
    );
    const base: AdOptimizationKnowledge = {
      version: "v1",
      publishedAt: new Date("2026-02-01T00:00:00Z"),
      publishedBy: "seed",
      active: true,
      entries: [...SEED_KNOWLEDGE_V1],
    };
    await repo.set("v1", base);
    await repo.set("v2", { ...base, version: "v2", active: true }); // hand-corrupted: two active

    await expect(loadActiveAdOptimizationKnowledge(db)).rejects.toThrow(
      /2 versions are marked active/,
    );
  });
});

describe("reproducibility — required for E1's backtest replay", () => {
  it("the same published version renders byte-for-byte identical prompt text on repeated loads", async () => {
    await refreshAdOptimizationKnowledge({
      db,
      version: "v1",
      publishedBy: "seed",
      entries: SEED_KNOWLEDGE_V1,
      now: new Date("2026-02-01T00:00:00Z"),
    });

    const first = await loadActiveAdOptimizationKnowledge(db);
    const second = await loadActiveAdOptimizationKnowledge(db);
    expect(renderKnowledgeForPrompt(first)).toBe(renderKnowledgeForPrompt(second));
  });
});
