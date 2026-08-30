// loadReportingCanon against a real (emulated) Firestore — proves the whole chain (repository
// layer's converter, the missing-doc throw, the invalid-doc throw, and the "loaded once"
// caching contract) works against the actual Admin SDK, not just the hand-rolled fake in
// loader.test.ts.
//
// Requires the Firestore emulator (a JVM on PATH) — run via `npm run test:integration`, which
// wraps this in `firebase emulators:exec` and sets FIRESTORE_EMULATOR_HOST. Not part of
// `npm run check`.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";
import { COLLECTIONS } from "../firestore/collections.ts";
import { createRepository } from "../firestore/repository.ts";
import { loadReportingCanon, resetReportingCanonCacheForTests } from "./loader.ts";
import { canonSettingsSchema, type CanonSettings } from "./settings.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "loader.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`, not `vitest run` directly.",
  );
}

if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

const VALID_SETTINGS: CanonSettings = {
  accountId: "act_emulator_test",
  reportingTimezone: "Asia/Kolkata",
  reportingCurrency: "INR",
  attributionWindow: "7d_click_1d_view",
  purchaseActionType: "offsite_conversion.fb_pixel_purchase",
  modelConfig: {
    recommendationProvider: "anthropic",
    recommendationModel: "claude-fable-5",
    creativeReasoningModel: "claude-fable-5",
    backgroundCreativeTaggingModel: "claude-haiku-4-5",
    taggingUsesBatchApi: true,
    effort: "high",
  },
};

async function cleanup() {
  const snaps = await db.collection(COLLECTIONS.settings).listDocuments();
  await Promise.all(snaps.map((ref) => ref.delete()));
}

beforeEach(async () => {
  resetReportingCanonCacheForTests();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

describe("loadReportingCanon (emulator)", () => {
  it("throws when settings/{accountId} does not exist", async () => {
    await expect(loadReportingCanon({ db, accountId: "act_does_not_exist" })).rejects.toThrow(
      /no settings\/act_does_not_exist document exists/,
    );
  });

  it("loads and validates a real stored settings document", async () => {
    const repo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
    await repo.set(VALID_SETTINGS.accountId, VALID_SETTINGS);

    const canon = await loadReportingCanon({ db, accountId: VALID_SETTINGS.accountId });
    expect(canon).toEqual(VALID_SETTINGS);
  });

  it("throws when the stored document fails validation (e.g. a hand-corrupted doc)", async () => {
    // Bypass the repository's own write-time validation to simulate a document already in the
    // database that predates a schema change, or was written by something outside this codebase.
    await db
      .collection(COLLECTIONS.settings)
      .doc("act_corrupt")
      .set({ accountId: "act_corrupt", reportingTimezone: "Asia/Kolkata" }); // missing required fields

    await expect(loadReportingCanon({ db, accountId: "act_corrupt" })).rejects.toThrow(
      /failed validation/,
    );
  });

  it("is loaded once: a document edited after the first load does not change the cached result", async () => {
    const repo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
    await repo.set(VALID_SETTINGS.accountId, VALID_SETTINGS);

    const first = await loadReportingCanon({ db, accountId: VALID_SETTINGS.accountId });
    expect(first.reportingCurrency).toBe("INR");

    // Mutate the stored document directly, simulating a live edit — the loader must NOT pick
    // this up, per A3's "treat these as write-once values; changing the canon at runtime is
    // out of scope."
    await repo.set(VALID_SETTINGS.accountId, { ...VALID_SETTINGS, reportingCurrency: "USD" });

    const second = await loadReportingCanon({ db, accountId: VALID_SETTINGS.accountId });
    expect(second.reportingCurrency).toBe("INR"); // still the cached original, not "USD"
  });
});
