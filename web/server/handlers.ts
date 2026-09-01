// D6 — framework-agnostic request handlers, mirroring D4's own `apiHandler.ts`/`httpHandler.ts`
// pattern exactly: plain data in, `{status, body}` out, no dependency on Node's `http` or any
// framework. server.ts is the only file that touches `http`; everything here is fully
// unit-testable without a running server. Every handler except `createRecommendationHandler`
// requires an `AuthenticatedUser` — see auth.ts and server.ts's own module comment for why (this
// is what makes §17.1's "all data served through the API" true for reads too).

import { z } from "zod";
import { COLLECTIONS } from "@shared/firestore/index.ts";
import { requestRecommendation } from "@services/reasoner/job/request.ts";
import type { AuthenticatedUser } from "./auth.ts";
import type { WebServerDeps } from "./deps.ts";
import { buildRecommendationView, listRecommendationSummaries } from "./viewModel.ts";
import type { RecommendationSummaryView, RecommendationView } from "./types.ts";

export interface ApiResponse<T> {
  status: number;
  body: T | { error: string };
}

const createRequestSchema = z.object({
  namedEntity: z.object({
    type: z.enum(["AD", "ADSET", "CAMPAIGN"]),
    id: z.string().min(1),
  }),
  question: z.string().min(1).max(2000).nullable().optional(),
});

/**
 * Writes PENDING + enqueues via D4's own unmodified `requestRecommendation`, patches on the
 * `namedEntity` D4's own doc doesn't carry (see the module comment on `recommendationSchema` in
 * shared/schema/decisions.ts for why this needs to be a separate, ordered step rather than a
 * schema-shape D4's own literal object could set), THEN fires the local dispatch — in that exact
 * order, so the dispatched worker's own read of the doc always sees `namedEntity` already
 * present, never a race. Returns 202 immediately; the dispatch itself is not awaited (§16.1's
 * whole point — the caller is expected to open the SSE stream next).
 */
export async function createRecommendationHandler(
  body: unknown,
  user: AuthenticatedUser,
  deps: WebServerDeps,
): Promise<ApiResponse<{ recommendationId: string }>> {
  const parsed = createRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: `invalid request body: ${parsed.error.message}` } };
  }

  const { recommendationId } = await requestRecommendation({
    db: deps.db,
    queue: deps.queue,
    namedEntity: parsed.data.namedEntity,
    requestedBy: user.email ?? user.uid,
    requestedQuestion: parsed.data.question ?? null,
  });

  await deps.db
    .collection(COLLECTIONS.recommendations)
    .doc(recommendationId)
    .update({ namedEntity: parsed.data.namedEntity });

  // Fire-and-forget on purpose (§16.1) — a Firebase Hosting rewrite/browser request must not
  // wait on a Fable-5-length turn. deps.dispatchLatest() itself never throws (see deps.ts); any
  // real failure becomes a legible FAILED state on the document, observed via GET/SSE.
  void deps.dispatchLatest();

  return { status: 202, body: { recommendationId } };
}

export async function getRecommendationHandler(
  recommendationId: string,
  _user: AuthenticatedUser,
  deps: WebServerDeps,
): Promise<ApiResponse<RecommendationView>> {
  const view = await buildRecommendationView(
    {
      db: deps.db,
      reportingCurrency: deps.reportingCurrency,
      reportingTimezone: deps.reportingTimezone,
    },
    recommendationId,
  );
  if (!view) return { status: 404, body: { error: `no recommendation ${recommendationId}` } };
  return { status: 200, body: view };
}

export async function listRecommendationsHandler(
  _user: AuthenticatedUser,
  deps: WebServerDeps,
  limit = 25,
): Promise<ApiResponse<{ recommendations: RecommendationSummaryView[] }>> {
  const recommendations = await listRecommendationSummaries(deps.db, { limit });
  return { status: 200, body: { recommendations } };
}

/**
 * Shared accept/reject validation: only a COMPLETE card can be actioned (never PENDING/
 * GENERATING/FAILED — nothing to accept yet; never REJECTED — the guardrail already downgraded
 * it, and its budget fields are cleared, so there is nothing actionable left to accept), and only
 * once (idempotent-safe: a second accept/reject on an already-decided card is a 409, not a silent
 * overwrite of the first decision).
 */
async function validateActionable(
  deps: WebServerDeps,
  recommendationId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const doc = await deps.db.collection(COLLECTIONS.recommendations).doc(recommendationId).get();
  if (!doc.exists)
    return { ok: false, status: 404, error: `no recommendation ${recommendationId}` };
  const data = doc.data();
  if (data?.status !== "COMPLETE") {
    return {
      ok: false,
      status: 409,
      error: `recommendation ${recommendationId} is ${String(data?.status)}, not COMPLETE — nothing actionable yet`,
    };
  }
  if (data.acceptedAt || data.rejectedByUserAt) {
    return {
      ok: false,
      status: 409,
      error: `recommendation ${recommendationId} was already decided`,
    };
  }
  return { ok: true };
}

export async function acceptRecommendationHandler(
  recommendationId: string,
  _user: AuthenticatedUser,
  deps: WebServerDeps,
): Promise<ApiResponse<{ accepted: true }>> {
  const check = await validateActionable(deps, recommendationId);
  if (!check.ok) return { status: check.status, body: { error: check.error } };
  await deps.db
    .collection(COLLECTIONS.recommendations)
    .doc(recommendationId)
    .update({ acceptedAt: new Date() });
  return { status: 200, body: { accepted: true } };
}

export async function rejectRecommendationHandler(
  recommendationId: string,
  _user: AuthenticatedUser,
  deps: WebServerDeps,
): Promise<ApiResponse<{ rejected: true }>> {
  const check = await validateActionable(deps, recommendationId);
  if (!check.ok) return { status: check.status, body: { error: check.error } };
  await deps.db
    .collection(COLLECTIONS.recommendations)
    .doc(recommendationId)
    .update({ rejectedByUserAt: new Date() });
  return { status: 200, body: { rejected: true } };
}
