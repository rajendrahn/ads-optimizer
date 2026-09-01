// D4 — the thin, framework-agnostic HTTP wrapper around `requestRecommendation` (request.ts).
// Mirrors services/ingest/sync/httpHandler.ts's own split exactly (that file's module comment:
// "deliberately framework-agnostic ... that is what makes retry semantics fully unit-testable
// without a Functions emulator or a live Cloud Tasks queue") — `handleRecommendationRequest`
// takes a plain parsed JSON body and returns a plain `{status, body}` pair, with no dependency on
// Express/Node's `http`/Cloud Run's request types at all. server.ts wraps this in a few lines of
// real HTTP glue for local/Cloud Run use; nothing about *how* a request is validated or turned
// into a PENDING doc + an enqueue lives there.
//
// **Scope note.** §17.1 (Firestore rules deny all client reads/writes; data is served through
// the API) and Firebase Auth belong to D6 ("all data served through the API, never direct client
// Firestore reads"). This handler is deliberately unauthenticated — it is the request-shaping and
// job-enqueuing logic §16.1 asks D4 to build, not the production-facing authenticated route. D6
// should wrap this (or server.ts's HTTP route) with real auth/session verification before it is
// reachable by an end user; nothing here should be treated as safe to expose publicly as-is.

import { recommendationRequestBodySchema } from "./types.ts";
import { requestRecommendation, type RequestRecommendationOptions } from "./request.ts";

export interface RecommendationRequestResponseBody {
  recommendationId?: string;
  error?: string;
}

export interface RecommendationRequestResponse {
  status: number;
  body: RecommendationRequestResponseBody;
}

export type HandleRecommendationRequestDeps = Omit<
  RequestRecommendationOptions,
  "namedEntity" | "requestedBy" | "requestedQuestion" | "recommendationId"
>;

/**
 * Validates the request body, calls `requestRecommendation`, and returns immediately with the
 * new id — this step's own "Done when": "a request returns immediately with an ID." `202
 * Accepted` (not `200`/`201`) because the body names work that has been enqueued, not a resource
 * that now exists in its final form — the client is expected to keep watching
 * `recommendations/{id}` via `onSnapshot` (D6) for the real outcome.
 */
export async function handleRecommendationRequest(
  request: unknown,
  deps: HandleRecommendationRequestDeps,
): Promise<RecommendationRequestResponse> {
  const parsed = recommendationRequestBodySchema.safeParse(request);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        error: `handleRecommendationRequest: invalid request body — ${parsed.error.message}`,
      },
    };
  }

  const result = await requestRecommendation({
    ...deps,
    namedEntity: parsed.data.namedEntity,
    requestedBy: parsed.data.requestedBy ?? null,
    requestedQuestion: parsed.data.requestedQuestion ?? null,
  });

  return { status: 202, body: { recommendationId: result.recommendationId } };
}
