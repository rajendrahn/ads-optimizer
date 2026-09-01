// D6 — the only place web/src talks to the network. Every call attaches the current Firebase ID
// token as `Authorization: Bearer <token>` — the API rejects anything else with 401 (§17.1's own
// gate; see web/server/server.ts's module comment). This file never imports `firebase/firestore`;
// it only ever calls this app's own `/api/...` routes.
//
// The SSE reader uses `fetch` + a manual `ReadableStream` reader instead of the browser's native
// `EventSource`, specifically because `EventSource` cannot set custom headers — there is no way
// to attach a bearer token to it. `fetch` can. Same wire protocol (`text/event-stream`,
// `event: .../data: ...\n\n` frames), just a header-capable client.

import { auth } from "../firebase.ts";
import type { RecommendationSummary, RecommendationView, ScalableEntityRef } from "./types.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) throw new ApiError("not signed in", 401);
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { ...(await authHeader()), ...(init?.headers ?? {}) };
  const res = await fetch(`/api${path}`, { ...init, headers });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `request failed with ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return body as T;
}

export async function createRecommendation(
  namedEntity: ScalableEntityRef,
  question: string | null,
): Promise<{ recommendationId: string }> {
  return apiFetch("/recommendations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ namedEntity, question }),
  });
}

export async function getRecommendation(recommendationId: string): Promise<RecommendationView> {
  return apiFetch(`/recommendations/${encodeURIComponent(recommendationId)}`);
}

export async function listRecommendations(): Promise<{ recommendations: RecommendationSummary[] }> {
  return apiFetch("/recommendations");
}

export async function acceptRecommendation(recommendationId: string): Promise<void> {
  await apiFetch(`/recommendations/${encodeURIComponent(recommendationId)}/accept`, {
    method: "POST",
  });
}

export async function rejectRecommendation(recommendationId: string): Promise<void> {
  await apiFetch(`/recommendations/${encodeURIComponent(recommendationId)}/reject`, {
    method: "POST",
  });
}

export interface SseHandlers {
  onRecommendation: (view: RecommendationView) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

/**
 * Streams `recommendations/:id/stream` and dispatches each `event: recommendation` frame — the
 * live "PENDING through to complete" subscription (§16.1), served by this API rather than a
 * direct client Firestore read (see web/server/server.ts's module comment). Returns an
 * `AbortController` the caller can use to close the connection early (e.g. the component
 * unmounting).
 */
export function streamRecommendation(
  recommendationId: string,
  handlers: SseHandlers,
): AbortController {
  const controller = new AbortController();

  void (async () => {
    const headers = await authHeader();
    let res: Response;
    try {
      res = await fetch(`/api/recommendations/${encodeURIComponent(recommendationId)}/stream`, {
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      handlers.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!res.ok || !res.body) {
      handlers.onError?.(`stream request failed with ${res.status}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let frameEnd: number;
        while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          if (frame.startsWith(":")) continue; // heartbeat comment

          const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!eventLine || !dataLine) continue;
          const event = eventLine.slice("event: ".length);
          const data: unknown = JSON.parse(dataLine.slice("data: ".length));

          if (event === "recommendation") handlers.onRecommendation(data as RecommendationView);
          else if (event === "error") handlers.onError?.((data as { error: string }).error);
          else if (event === "done") handlers.onDone?.();
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        handlers.onError?.(err instanceof Error ? err.message : String(err));
      }
    }
  })();

  return controller;
}
