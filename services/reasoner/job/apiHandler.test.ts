// Pure, no-Firestore-needed coverage of the request-validation branch — the 202/error shaping
// `handleRecommendationRequest` does BEFORE ever calling `requestRecommendation`. The success
// path (write PENDING + enqueue) is proven against a real emulator in
// generateRecommendationTask.emulator.test.ts's own test 1 ("a request returns immediately with
// an ID") — duplicating that here with a fake Firestore would test less, not more.

import { describe, expect, it } from "vitest";
import type { TaskQueueClient } from "@services/ingest/sync/taskQueue.ts";
import { handleRecommendationRequest } from "./apiHandler.ts";

function neverCalledQueue(): TaskQueueClient {
  return {
    enqueue: async () => {
      throw new Error("must not be called for an invalid request");
    },
  };
}

describe("handleRecommendationRequest — request validation", () => {
  it("400s on a missing namedEntity, without touching the queue", async () => {
    const result = await handleRecommendationRequest(
      { requestedQuestion: "no namedEntity here" },
      { queue: neverCalledQueue() },
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/invalid request body/);
    expect(result.body.recommendationId).toBeUndefined();
  });

  it("400s on an invalid entity type, without touching the queue", async () => {
    const result = await handleRecommendationRequest(
      { namedEntity: { type: "CREATIVE_FAMILY", id: "fam_1" } },
      { queue: neverCalledQueue() },
    );
    expect(result.status).toBe(400);
  });

  it("400s on a non-object body, without touching the queue", async () => {
    const result = await handleRecommendationRequest("not an object", {
      queue: neverCalledQueue(),
    });
    expect(result.status).toBe(400);
  });

  it("400s on an empty string id, without touching the queue", async () => {
    const result = await handleRecommendationRequest(
      { namedEntity: { type: "AD", id: "" } },
      { queue: neverCalledQueue() },
    );
    expect(result.status).toBe(400);
  });
});
