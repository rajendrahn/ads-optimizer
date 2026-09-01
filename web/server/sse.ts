// D6 — the live-status subscription. Resolves the onSnapshot-vs-§17.1 contradiction the step
// brief names explicitly: see server.ts's module comment for the full write-up of why this is an
// SSE stream served directly by this API (never a client-side `onSnapshot`) and why
// `firestore.rules` stays the deny-all boundary A2 proved, unchanged.
//
// Mechanically: the Admin SDK's OWN `onSnapshot` (a server-side listener — the Admin SDK always
// has full access and is never subject to `firestore.rules`, exactly like every other read in
// this file already is) drives a live subscription on `recommendations/{id}` inside THIS process;
// each snapshot is joined into a `RecommendationView` (viewModel.ts, same as the plain GET route,
// so the two never disagree about shape) and written as one `data: {...}\n\n` SSE frame. This is
// "the client subscribes... gives progress states for free" (§16.1), just relayed through a
// server-owned listener instead of a client-owned one — the browser never opens a Firestore
// connection or sees a Firestore credential at all.

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS } from "@shared/firestore/index.ts";
import { buildRecommendationView } from "./viewModel.ts";
import type { RecommendationView } from "./types.ts";

/** The Admin SDK's `DocumentReference#onSnapshot` returns a plain unsubscribe function — there is
 * no exported `Unsubscribe` type name in `firebase-admin/firestore` (unlike the client SDK) to
 * import, so it is named locally here. */
type Unsubscribe = () => void;

/** The minimal write surface this needs — a real Node `ServerResponse` satisfies it structurally
 * (same seam pattern as every other "*Like" interface in this codebase); a test can inject a
 * plain in-memory sink instead, with no HTTP server involved at all. */
export interface SseSink {
  write(chunk: string): void;
  end(): void;
  /** Registers a callback for the underlying connection closing (the browser navigated away, the
   * tab closed, network drop) — used to unsubscribe the Firestore listener promptly rather than
   * leaking it for the life of the process. */
  onClose(cb: () => void): void;
}

const TERMINAL_STATUSES = new Set(["COMPLETE", "FAILED", "REJECTED"]);

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface StreamOptions {
  db: Firestore;
  reportingCurrency: string;
  reportingTimezone: string;
  recommendationId: string;
  sink: SseSink;
  /** Overridable for tests — real callers get 15s, fast enough to survive most proxy/load-balancer
   * idle-connection timeouts, slow enough to be negligible bandwidth. */
  heartbeatMs?: number;
}

/**
 * Streams `RecommendationView` snapshots for one recommendation until it reaches a terminal
 * status (COMPLETE/FAILED/REJECTED — §16.1: "from PENDING to complete"), then sends a `done`
 * event and closes. A recommendation that does not exist gets one `error` event and an immediate
 * close, never a hung connection. Returns a promise that resolves once the stream has ended (test
 * convenience — a real HTTP server does not need to await this).
 */
export function streamRecommendation(opts: StreamOptions): Promise<void> {
  const { db, recommendationId, sink } = opts;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  return new Promise((resolve) => {
    let closed = false;

    // `unsubscribe`/`heartbeat` are referenced inside `finish`, declared below, but `function`
    // declarations hoist their full body — `finish` can close over both safely since neither is
    // ever actually CALLED before this whole synchronous block finishes setting them up.
    function finish(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      sink.end();
      resolve();
    }

    sink.onClose(finish);
    const heartbeat = setInterval(() => {
      if (!closed) sink.write(": heartbeat\n\n");
    }, heartbeatMs);

    const unsubscribe: Unsubscribe = db
      .collection(COLLECTIONS.recommendations)
      .doc(recommendationId)
      .onSnapshot(
        (snap) => {
          if (closed) return;
          if (!snap.exists) {
            sink.write(frame("error", { error: `no recommendation ${recommendationId}` }));
            finish();
            return;
          }
          void buildRecommendationView(
            {
              db,
              reportingCurrency: opts.reportingCurrency,
              reportingTimezone: opts.reportingTimezone,
            },
            recommendationId,
          ).then((view: RecommendationView | null) => {
            if (closed || !view) return;
            sink.write(frame("recommendation", view));
            if (TERMINAL_STATUSES.has(view.status)) {
              sink.write(frame("done", {}));
              finish();
            }
          });
        },
        (err) => {
          if (closed) return;
          sink.write(frame("error", { error: err instanceof Error ? err.message : String(err) }));
          finish();
        },
      );
  });
}
