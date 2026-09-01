// Pure coverage of createRecommendationHandler's request-validation branch — the 400 shaping done
// BEFORE ever touching Firestore or the queue (mirrors services/reasoner/job/apiHandler.test.ts's
// own convention exactly: a fake `db`/`queue` that throws if actually called proves the validation
// short-circuit is real, not merely asserted). The success path (write PENDING, patch
// namedEntity, dispatch) is proven against a real emulator in webApi.emulator.test.ts — duplicating
// that here with a fake Firestore would test less, not more.

import { describe, expect, it, vi } from "vitest";
import { createRecommendationHandler } from "./handlers.ts";
import type { AuthenticatedUser } from "./auth.ts";
import type { WebServerDeps } from "./deps.ts";

const USER: AuthenticatedUser = { uid: "u1", email: "a@example.com" };

function neverTouchedDeps(): WebServerDeps {
  const fail = (label: string) => {
    throw new Error(`must not be called for an invalid request: ${label}`);
  };
  return {
    db: new Proxy({}, { get: () => fail("db") }) as unknown as WebServerDeps["db"],
    reportingCurrency: "INR",
    reportingTimezone: "Asia/Kolkata",
    authVerifier: { verifyIdToken: vi.fn(() => fail("authVerifier")) },
    queue: { enqueue: vi.fn(() => fail("queue")) },
    dispatchLatest: vi.fn(() => fail("dispatchLatest")),
  };
}

describe("createRecommendationHandler — request validation", () => {
  it("400s on a missing namedEntity, without touching Firestore or the queue", async () => {
    const result = await createRecommendationHandler(
      { question: "no namedEntity here" },
      USER,
      neverTouchedDeps(),
    );
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/invalid request body/);
  });

  it("400s on an invalid entity type", async () => {
    const result = await createRecommendationHandler(
      { namedEntity: { type: "CREATIVE_FAMILY", id: "fam_1" } },
      USER,
      neverTouchedDeps(),
    );
    expect(result.status).toBe(400);
  });

  it("400s on a non-object body", async () => {
    const result = await createRecommendationHandler("not an object", USER, neverTouchedDeps());
    expect(result.status).toBe(400);
  });

  it("400s on an empty entity id", async () => {
    const result = await createRecommendationHandler(
      { namedEntity: { type: "AD", id: "" } },
      USER,
      neverTouchedDeps(),
    );
    expect(result.status).toBe(400);
  });

  it("400s on a question over the 2000-character cap", async () => {
    const result = await createRecommendationHandler(
      { namedEntity: { type: "AD", id: "ad_1" }, question: "x".repeat(2001) },
      USER,
      neverTouchedDeps(),
    );
    expect(result.status).toBe(400);
  });
});
