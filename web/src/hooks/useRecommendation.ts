// D6 — drives one recommendation's live status from PENDING through to a terminal state, via the
// SSE stream (client.ts's `streamRecommendation`) — never a client-side Firestore `onSnapshot`.

import { useCallback, useEffect, useRef, useState } from "react";
import { getRecommendation, streamRecommendation } from "../api/client.ts";
import type { RecommendationView } from "../api/types.ts";

export interface UseRecommendationResult {
  view: RecommendationView | null;
  streamError: string | null;
  refresh: () => void;
}

/** Subscribes to `recommendationId`'s live stream for as long as it is mounted and the id is
 * non-null. An initial `GET` is fired in parallel with opening the stream so the card has
 * something to render even before the first SSE frame arrives (the stream's own first frame,
 * once it lands, supersedes it — both go through the exact same `RecommendationView` shape). */
export function useRecommendation(recommendationId: string | null): UseRecommendationResult {
  const [view, setView] = useState<RecommendationView | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    controllerRef.current?.abort();
    // Resetting transient UI state (a stale error from the PREVIOUS recommendationId's
    // subscription) when the subscription itself is torn down and re-opened is exactly the kind
    // of external-system synchronization useEffect exists for, not state that can be derived
    // during render (it depends on the SSE connection's own lifecycle, not on props/state alone).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStreamError(null);
    if (!recommendationId) {
      setView(null);
      return;
    }

    let cancelled = false;
    void getRecommendation(recommendationId)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => void 0); // the stream's own onError below covers real failures

    const controller = streamRecommendation(recommendationId, {
      onRecommendation: (v) => {
        if (!cancelled) setView(v);
      },
      onError: (message) => {
        if (!cancelled) setStreamError(message);
      },
    });
    controllerRef.current = controller;

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [recommendationId]);

  const refresh = useCallback(() => {
    if (!recommendationId) return;
    void getRecommendation(recommendationId).then(setView);
  }, [recommendationId]);

  return { view, streamError, refresh };
}
