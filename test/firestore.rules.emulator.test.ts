// §17.1: "Firestore rules deny all client reads and writes; data is served through the
// API." This proves it, collection by collection, against a real (emulated) Firestore —
// unauthenticated AND authenticated clients are both denied read and write on every
// collection in §8. The Admin SDK (used by the API / Cloud Run / Cloud Functions) bypasses
// these rules entirely, so it is deliberately not exercised here.
//
// Requires the Firestore emulator (a JVM on PATH) — run via `npm run test:integration`,
// which wraps this in `firebase emulators:exec`. Not part of `npm run check`.

import { readFileSync } from "node:fs";
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../scripts/config.ts";
import { COLLECTIONS } from "../shared/firestore/collections.ts";

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: GCP_PROJECT_ID,
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

const collectionNames = Object.values(COLLECTIONS);

describe("firestore.rules — §17.1 deny-all", () => {
  it("covers every collection in §8 (guards against this test file drifting from collections.ts)", () => {
    expect(collectionNames.length).toBe(35); // 24 + B3's metaInsightsReportJobs + B7's adUrlTagAudits + C1's 4 + C5's seasonalCalendarWindows + C2's creativeFamilyFeatures + D3.1's adOptimizationKnowledge + D5's guardrailRejections + the post-B2 defect fix's metaEntitySyncJobs
  });

  it.each(collectionNames)("denies an unauthenticated client reading %s", async (name) => {
    const unauth = testEnv.unauthenticatedContext();
    await assertFails(unauth.firestore().collection(name).doc("probe").get());
  });

  it.each(collectionNames)("denies an unauthenticated client writing %s", async (name) => {
    const unauth = testEnv.unauthenticatedContext();
    await assertFails(unauth.firestore().collection(name).doc("probe").set({ a: 1 }));
  });

  it.each(collectionNames)("denies an authenticated client reading %s", async (name) => {
    const auth = testEnv.authenticatedContext("some-user-id");
    await assertFails(auth.firestore().collection(name).doc("probe").get());
  });

  it.each(collectionNames)("denies an authenticated client writing %s", async (name) => {
    const auth = testEnv.authenticatedContext("some-user-id");
    await assertFails(auth.firestore().collection(name).doc("probe").set({ a: 1 }));
  });

  it("denies a client listing a top-level collection outright", async () => {
    const unauth = testEnv.unauthenticatedContext();
    await assertFails(unauth.firestore().collection("metaCampaigns").get());
  });

  it("denies a client reading an arbitrary, unlisted collection too (the rule is a true blanket deny)", async () => {
    const unauth = testEnv.unauthenticatedContext();
    await assertFails(unauth.firestore().collection("somethingNotInTheSchema").doc("x").get());
  });
});
