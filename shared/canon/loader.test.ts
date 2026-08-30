// loadReportingCanon — pure unit tests against a hand-rolled fake Firestore, in the same
// spirit as shared/firestore/repository.test.ts and versionGuard.test.ts: exercise the
// throw-on-missing, throw-on-invalid and caching behaviour without needing a real emulator.
// End-to-end coverage against a real (emulated) Firestore lives in loader.emulator.test.ts.

import type { Firestore } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { loadReportingCanon, resetReportingCanonCacheForTests } from "./loader.ts";
import type { CanonSettings } from "./settings.ts";

interface FakeConverter {
  toFirestore(model: unknown): unknown;
  fromFirestore(snapshot: { data(): unknown }): unknown;
}

/** Minimal fake satisfying exactly the chain repository.ts's collectionRef/get() calls:
 *  db.collection(name).withConverter(conv).doc(id).get() -> {exists, data()}. */
function createFakeFirestore(initialDocs: Record<string, unknown> = {}): {
  db: Firestore;
  getCallCount: () => number;
} {
  const store = new Map(Object.entries(initialDocs));
  let getCallCount = 0;
  const fakeDb = {
    collection(_name: string) {
      return {
        withConverter(converter: FakeConverter) {
          return {
            doc(id: string) {
              return {
                get: async () => {
                  getCallCount++;
                  const raw = store.get(id);
                  return {
                    exists: raw !== undefined,
                    data: () =>
                      raw === undefined ? undefined : converter.fromFirestore({ data: () => raw }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { db: fakeDb as unknown as Firestore, getCallCount: () => getCallCount };
}

const VALID_SETTINGS: CanonSettings = {
  accountId: "act_test123",
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

beforeEach(() => {
  resetReportingCanonCacheForTests();
});

describe("loadReportingCanon", () => {
  it("throws when no settings document exists — never defaults", async () => {
    const { db } = createFakeFirestore({});
    await expect(loadReportingCanon({ db, accountId: "act_missing" })).rejects.toThrow(
      /no settings\/act_missing document exists/,
    );
  });

  it("throws when the stored document fails validation", async () => {
    const { db } = createFakeFirestore({
      act_bad: { accountId: "act_bad", reportingTimezone: "Asia/Kolkata" }, // missing required fields
    });
    await expect(loadReportingCanon({ db, accountId: "act_bad" })).rejects.toThrow(
      /failed validation/,
    );
  });

  it("returns the validated canon for a valid document", async () => {
    const { db } = createFakeFirestore({ act_test123: VALID_SETTINGS });
    const canon = await loadReportingCanon({ db, accountId: "act_test123" });
    expect(canon).toEqual(VALID_SETTINGS);
  });

  it("caches after the first successful load — a second call does not re-read Firestore", async () => {
    const { db, getCallCount } = createFakeFirestore({ act_test123: VALID_SETTINGS });
    await loadReportingCanon({ db, accountId: "act_test123" });
    expect(getCallCount()).toBe(1);

    await loadReportingCanon({ db, accountId: "act_test123" });
    expect(getCallCount()).toBe(1); // still 1 — the second call was served from cache
  });

  it("does NOT cache a failed load — a subsequent call retries", async () => {
    const { db, getCallCount } = createFakeFirestore({}); // no doc yet
    await expect(loadReportingCanon({ db, accountId: "act_retry" })).rejects.toThrow();
    expect(getCallCount()).toBe(1);

    await expect(loadReportingCanon({ db, accountId: "act_retry" })).rejects.toThrow();
    expect(getCallCount()).toBe(2); // retried, not silently stuck on the first failure
  });

  it("resetReportingCanonCacheForTests forces a fresh read", async () => {
    const { db, getCallCount } = createFakeFirestore({ act_test123: VALID_SETTINGS });
    await loadReportingCanon({ db, accountId: "act_test123" });
    expect(getCallCount()).toBe(1);

    resetReportingCanonCacheForTests();
    await loadReportingCanon({ db, accountId: "act_test123" });
    expect(getCallCount()).toBe(2);
  });

  it("caches independently per accountId", async () => {
    const { db, getCallCount } = createFakeFirestore({
      act_a: { ...VALID_SETTINGS, accountId: "act_a" },
      act_b: { ...VALID_SETTINGS, accountId: "act_b" },
    });
    await loadReportingCanon({ db, accountId: "act_a" });
    await loadReportingCanon({ db, accountId: "act_b" });
    expect(getCallCount()).toBe(2);
    await loadReportingCanon({ db, accountId: "act_a" });
    await loadReportingCanon({ db, accountId: "act_b" });
    expect(getCallCount()).toBe(2); // both served from cache the second time
  });
});
