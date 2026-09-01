// D4 — the actual Cloud Run entrypoint. Deliberately the ONLY file in this job pipeline that
// touches Node's `http` module or knows what a port is — everything it calls
// (handleReasonerTaskDispatch, handleRecommendationRequest) is framework-agnostic and already
// fully covered by this step's own tests. This file is intentionally thin, mirroring B1's own
// `functions/src/index.ts` ("genuinely thin: one handler that parses the request body and calls
// [the framework-agnostic function]. Nothing about *how* a task runs ... lives there").
//
// Serves two routes on one process, one Cloud Run service — §17.1's own "with one account and a
// small user set this is a few lines, not a design problem" reasoning applies equally here. An
// operator who later wants the API and the reasoner worker on separately-scaled Cloud Run
// services can split this file in two along the two route handlers below with no change to
// either handler; nothing about them assumes they share a process.
//
//   POST /tasks/dispatch   — the Cloud Tasks HTTP target (workerRuntime.ts)
//   POST /recommendations  — the request-a-recommendation route (apiRuntime.ts) — UNAUTHENTICATED,
//                            see apiHandler.ts's own scope note: D6 owns wrapping this in real
//                            Firebase Auth verification before it is exposed to end users.
//
// Not started anywhere in this step's own tests — this file is exercised only by actually
// running it (`tsx services/reasoner/job/server.ts`), which this step's safety constraints
// (no deploy, no live server) deliberately do not do. See IMPLEMENTATION_PLAN.md D4's own notes
// for the exact commands an operator runs to build/deploy this for real.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleReasonerTaskDispatch } from "./workerRuntime.ts";
import { handleRecommendationRequest } from "./apiHandler.ts";
import { getApiRuntimeDeps } from "./apiRuntime.ts";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (cause) {
    sendJson(res, 400, {
      error: `invalid JSON body: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    return;
  }

  if (req.url === "/tasks/dispatch") {
    const result = await handleReasonerTaskDispatch(body as never);
    sendJson(res, result.status, result.body);
    return;
  }

  if (req.url === "/recommendations") {
    const result = await handleRecommendationRequest(body, getApiRuntimeDeps());
    sendJson(res, result.status, result.body);
    return;
  }

  sendJson(res, 404, { error: `no route for ${req.method} ${req.url}` });
}

const port = Number(process.env.PORT ?? 8080);
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    console.error("[reasoner-worker] unhandled error", err);
    sendJson(res, 500, { error: "internal error" });
  });
});
server.listen(port, () => {
  console.log(`[reasoner-worker] listening on :${port}`);
});
