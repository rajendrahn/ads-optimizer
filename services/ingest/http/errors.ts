// Shared error shape for both platform clients (Meta, Shopify). One class, parametrized by
// `kind` + `retryable`, rather than a class per failure mode — the thing every later piece
// (retry loop, health check, sync controller) actually branches on is these two fields, not
// the exception's type.

/**
 * - `unauthorized` — the credential itself is bad (expired/revoked token, bad signature).
 *   Never retryable; this is what §9.6's health check surfaces to the UI.
 * - `rate_limited` — a 429, a Meta rate-limit error code, or a Shopify `THROTTLED` GraphQL
 *   error. Retryable; the caller should back off (ideally using the platform's own reported
 *   throttle state — see `meta/buc.ts` / `shopify/cost.ts` — rather than blind backoff alone).
 * - `server_error` — 5xx or an platform-reported internal error. Retryable; probably transient.
 * - `client_error` — any other 4xx / GraphQL validation error. Terminal — retrying an
 *   unchanged malformed request will not succeed.
 * - `network` — the request never got a response at all (DNS, connection reset, timeout).
 *   Retryable by default in `withRetry` (see below) since these are usually transient.
 */
export type ApiErrorKind =
  "unauthorized" | "rate_limited" | "server_error" | "client_error" | "network";

export interface ApiErrorOptions {
  kind: ApiErrorKind;
  retryable: boolean;
  status?: number;
  raw?: unknown;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly raw?: unknown;

  constructor(message: string, opts: ApiErrorOptions) {
    super(message);
    this.name = "ApiError";
    this.kind = opts.kind;
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.raw = opts.raw;
  }
}
