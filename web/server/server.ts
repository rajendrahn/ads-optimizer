// D6 — the web API's actual HTTP entrypoint (Cloud Run, in production). Mirrors D4's own
// `server.ts` exactly in spirit: the ONE file that touches Node's `http` module; every handler it
// calls (handlers.ts, sse.ts) is framework-agnostic and independently unit-tested.
//
// ============================================================================================
// THE CONTRADICTION THIS STEP'S BRIEF NAMES, AND HOW IT IS RESOLVED HERE
// ============================================================================================
//
// The brief states both: §17.1 — "Firestore rules deny all client reads and writes; all data
// served through the API, never direct client Firestore reads" — and the design's own
// architecture diagram (§16.1) — "the client subscribes with `onSnapshot`." Those genuinely
// conflict: `onSnapshot` from a browser IS a direct client Firestore read, and A2's
// `firestore.rules` (a blanket `allow read, write: if false` on every collection, proved by 99
// emulator tests — test/firestore.rules.emulator.test.ts, unchanged by this step) would simply
// deny it today.
//
// **Resolved as: keep `firestore.rules` exactly as A2 left it, and drive "live status from
// PENDING to complete" through a server-owned SSE stream instead of a client-owned
// `onSnapshot`** (GET /api/recommendations/:id/stream, sse.ts). Every byte of Firestore data the
// browser ever sees is assembled by THIS process (using the Admin SDK, which is never subject to
// `firestore.rules` in the first place — no client Firebase credential, no client Firestore SDK
// import, anywhere in web/src) and handed across as plain JSON over `fetch`. The browser's
// Firebase usage is Auth only (`web/src/firebase.ts` imports `firebase/app` + `firebase/auth`,
// never `firebase/firestore` — enforced by a `no-restricted-imports` rule in web/eslint.config.js,
// not merely a convention).
//
// This was NOT the only defensible choice — option (b) would have been to relax
// `firestore.rules` narrowly so an authenticated user may read only their own
// `recommendations/{id}` documents (e.g. `allow read: if request.auth != null && resource.data.
// requestedBy == request.auth.token.email`), keeping every other collection denied, and let the
// browser call `onSnapshot` directly as the design's diagram literally shows. That was rejected
// for three concrete reasons, not aesthetic preference:
//   1. **§17.1's own sentence is unconditional.** It does not say "except reads of a user's own
//      recommendation" — it says "all data served through the API," full stop, immediately
//      followed by the architecture's own §16.1 note that Cloud Run is where the reasoner (and,
//      by the same reasoning, the API) lives specifically BECAUSE some responses (Fable 5 turns)
//      cannot fit inside a synchronous Hosting-rewrite request. An SSE stream from that same
//      Cloud Run service is not a new mechanism this design didn't already anticipate — §16.1
//      says exactly that, for "streaming conversational follow-ups... bypassing the Hosting
//      rewrite." A recommendation's live status is the same shape of problem (a value that
//      changes over the lifetime of one request-worthy question), so the same mechanism applies
//      cleanly, without inventing anything §16.1 didn't already point at.
//   2. **Loosening the rules is a one-way ratchet on a boundary A2 spent real effort proving.**
//      99 tests exist specifically to prove NOTHING is client-readable. Every future collection
//      this system ever adds inherits deny-by-default for free today; carving an exception means
//      every future author must remember the carve-out exists and reason about it — and a
//      carve-out on `recommendations` in particular is uncomfortably close to the collection that
//      also carries `requestedQuestion` (freeform user text) and, via the joined packet, business
//      figures (spend, revenue, ROAS) this account has not decided it wants sitting in a
//      client-readable document at all, independent of Firebase Auth's own client-side trust
//      model (a leaked/replayed ID token, a XSS bug in the web app, a future public-facing
//      surface reusing the same rules file) — none of which the API-mediated design exposes,
//      because the browser never holds a credential Firestore itself would honor.
//   3. **It is not necessary.** The SSE approach delivers the identical UX guarantee the design
//      diagram is actually after — "gives progress states for free," PENDING through every
//      intermediate write to a terminal state, observed live, no polling — with strictly less
//      surface area than a rules change plus a new rules-test suite plus a new attack surface to
//      reason about for a resource this account's own scale (10-30 cards/day, §19.2) does not
//      need low-latency fan-out for.
//
// **Resulting security posture, stated plainly:** `firestore.rules` is byte-for-byte what A2
// wrote — no client, authenticated or not, can read or write ANY collection directly. Every
// response the browser ever receives — GET /api/recommendations, GET .../:id, the SSE stream,
// POST create/accept/reject — passes through `web/server/auth.ts`'s `verifyAuthHeader` first
// (a valid, unexpired Firebase ID token or a 401, uniformly) and then through this process's own
// Admin SDK, which the browser never touches. If this were being relaxed instead, this comment
// would instead need to say exactly what a client can now read (recommendations they requested,
// full stop) and why every other collection stays closed — see the step's own instructions on
// what an honest write-up of option (b) requires. That sentence is not needed here because (a)
// was chosen: nothing changed in `firestore.rules`, and `test/firestore.rules.emulator.test.ts`
// (A2's 99 tests) is run unmodified, unrelaxed, by this step's own `npm run test:integration`.
// ============================================================================================

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { verifyAuthHeader } from "./auth.ts";
import { getWebServerDeps } from "./deps.ts";
import {
  acceptRecommendationHandler,
  createRecommendationHandler,
  getRecommendationHandler,
  listRecommendationsHandler,
  rejectRecommendationHandler,
} from "./handlers.ts";
import { streamRecommendation, type SseSink } from "./sse.ts";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": corsOrigin(),
  });
  res.end(payload);
}

/** Reflects a single configured origin (or "*" if none is set — fine for local dev; an operator
 * deploying for real should set WEB_CORS_ORIGIN to the exact Hosting origin). Not needed at all
 * once Firebase Hosting rewrites `/api/**` to this service (same-origin) — kept as a fallback for
 * direct-to-Cloud-Run access during development, per this step's own "operator can split
 * services" note in D4's report. */
function corsOrigin(): string {
  return process.env.WEB_CORS_ORIGIN ?? "*";
}

function sendSse(res: ServerResponse): SseSink {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": corsOrigin(),
    "X-Accel-Buffering": "no", // disable nginx/Cloud Run buffering of the stream
  });
  return {
    write: (chunk) => res.write(chunk),
    end: () => res.end(),
    onClose: (cb) => res.on("close", cb),
  };
}

const RECOMMENDATION_ID_RE = /^\/api\/recommendations\/([^/]+)(\/(stream|accept|reject))?$/;

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": corsOrigin(),
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  if (url === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const deps = await getWebServerDeps();
  const user = await verifyAuthHeader(
    req.headers as Record<string, string | string[] | undefined>,
    deps.authVerifier,
  );
  if (!user) {
    sendJson(res, 401, { error: "missing or invalid Authorization bearer token" });
    return;
  }

  if (url === "/api/recommendations" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = await createRecommendationHandler(body, user, deps);
    sendJson(res, result.status, result.body);
    return;
  }

  if (
    (url === "/api/recommendations" || url.startsWith("/api/recommendations?")) &&
    req.method === "GET"
  ) {
    const result = await listRecommendationsHandler(user, deps);
    sendJson(res, result.status, result.body);
    return;
  }

  const match = RECOMMENDATION_ID_RE.exec(url);
  if (match) {
    const [, recommendationId, , subroute] = match;
    if (!subroute && req.method === "GET") {
      const result = await getRecommendationHandler(recommendationId, user, deps);
      sendJson(res, result.status, result.body);
      return;
    }
    if (subroute === "stream" && req.method === "GET") {
      const sink = sendSse(res);
      await streamRecommendation({
        db: deps.db,
        reportingCurrency: deps.reportingCurrency,
        reportingTimezone: deps.reportingTimezone,
        recommendationId,
        sink,
      });
      return;
    }
    if (subroute === "accept" && req.method === "POST") {
      const result = await acceptRecommendationHandler(recommendationId, user, deps);
      sendJson(res, result.status, result.body);
      return;
    }
    if (subroute === "reject" && req.method === "POST") {
      const result = await rejectRecommendationHandler(recommendationId, user, deps);
      sendJson(res, result.status, result.body);
      return;
    }
  }

  sendJson(res, 404, { error: `no route for ${req.method} ${url}` });
}

const port = Number(process.env.PORT ?? 8081);
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    console.error("[web-api] unhandled error", err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    else res.end();
  });
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(`[web-api] listening on :${port}`);
  });
}

export { server, handleRequest };
