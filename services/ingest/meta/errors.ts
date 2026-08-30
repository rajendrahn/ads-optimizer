// Classifies a Graph API response into retryable vs terminal, per the A4 spec's "retry with
// exponential backoff, distinguishing retryable from terminal failures."
//
// Graph API error body shape:
//   { "error": { "message": string, "type": string, "code": number, "error_subcode"?: number,
//                "fbtrace_id": string } }
//
// The code lists below are Meta's documented codes for the two cases this module actually
// needs to get right — "the token is bad" and "we're being rate limited" — not an exhaustive
// map of every Graph API error code. Extend them if Phase B observes a code that should be
// classified differently; err on the side of `client_error` (terminal) for anything unknown
// rather than silently retrying a request that will never succeed.

import { ApiError } from "../http/errors.ts";

/** OAuthException / invalid or expired access token. */
const UNAUTHORIZED_CODES = new Set([190]);

/** Meta's rate-limit family: 4 = app-level request limit, 17 = user-level request limit,
 * 32 = page-level rate limit, 613 = custom/ads rate limit. */
const RATE_LIMITED_CODES = new Set([4, 17, 32, 613]);

interface GraphApiErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

function isGraphApiErrorBody(body: unknown): body is GraphApiErrorBody {
  return typeof body === "object" && body !== null && "error" in body;
}

export function classifyMetaError(status: number, body: unknown): ApiError {
  const error = isGraphApiErrorBody(body) ? body.error : undefined;
  const code = error?.code;
  const message = error?.message ?? `HTTP ${status}`;

  if (code !== undefined && UNAUTHORIZED_CODES.has(code)) {
    return new ApiError(`Meta: unauthorized (code ${code}): ${message}`, {
      kind: "unauthorized",
      retryable: false,
      status,
      raw: body,
    });
  }
  if (code !== undefined && RATE_LIMITED_CODES.has(code)) {
    return new ApiError(`Meta: rate limited (code ${code}): ${message}`, {
      kind: "rate_limited",
      retryable: true,
      status,
      raw: body,
    });
  }
  if (status === 401 || status === 403) {
    return new ApiError(`Meta: unauthorized (HTTP ${status}): ${message}`, {
      kind: "unauthorized",
      retryable: false,
      status,
      raw: body,
    });
  }
  if (status === 429) {
    return new ApiError(`Meta: rate limited (HTTP 429): ${message}`, {
      kind: "rate_limited",
      retryable: true,
      status,
      raw: body,
    });
  }
  if (status >= 500) {
    return new ApiError(`Meta: server error (HTTP ${status}): ${message}`, {
      kind: "server_error",
      retryable: true,
      status,
      raw: body,
    });
  }
  return new ApiError(`Meta: request failed (HTTP ${status}): ${message}`, {
    kind: "client_error",
    retryable: false,
    status,
    raw: body,
  });
}
