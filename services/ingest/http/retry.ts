// Generic retry with exponential backoff, shared by the Meta and Shopify clients.
//
// The one decision worth calling out: what gets retried at all. `ApiError.retryable`
// (services/ingest/http/errors.ts) is the terminal-vs-retryable distinction the A4 spec asks
// for — a `client_error` or `unauthorized` classification bails immediately with no wasted
// attempts, while `rate_limited` / `server_error` (and anything that isn't an `ApiError` at
// all — a raw network failure) gets backed off and retried.

import { ApiError } from "./errors.ts";
import { sleep as realSleep } from "./sleep.ts";

export interface RetryOptions {
  /** Total attempts including the first — default 5. */
  maxAttempts?: number;
  /** Base delay for attempt 1's backoff window — default 500ms. */
  baseDelayMs?: number;
  /** Backoff window is capped here regardless of attempt number — default 30s. */
  maxDelayMs?: number;
  /** Override the retryable/terminal decision. Default: `ApiError.retryable`, or `true` for
   * anything that isn't an `ApiError` (network failures are presumed transient). */
  isRetryable?: (error: unknown) => boolean;
  /** Injectable for tests — default `services/ingest/http/sleep.ts`'s real `setTimeout` one. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof ApiError) return error.retryable;
  return true;
}

/**
 * Full-jitter exponential backoff: a uniformly random delay in `[0, min(maxDelayMs, base *
 * 2^(attempt-1))]`. Exported separately from `withRetry` so the growth/cap behaviour has its
 * own deterministic tests independent of the async retry loop.
 */
export function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const window = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * window);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;
  const sleepFn = options.sleep ?? realSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const attemptsRemain = attempt < maxAttempts;
      if (!attemptsRemain || !isRetryable(error)) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.({ attempt, delayMs, error });
      await sleepFn(delayMs);
    }
  }
  // Unreachable — the loop above always either returns or throws — but keeps the return type
  // `T` rather than `T | undefined` without a non-null assertion at the call site.
  throw new Error("withRetry: exhausted attempts without returning or throwing");
}
