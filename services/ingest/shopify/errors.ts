// Classifies a Shopify GraphQL Admin API response into retryable vs terminal.
//
// Shopify GraphQL errors are usually returned as HTTP 200 with a top-level `errors` array,
// each with an optional `extensions.code`:
//
//   { "errors": [{ "message": "Throttled", "extensions": { "code": "THROTTLED" } }] }
//
// `THROTTLED` means the leaky bucket (see shopify/cost.ts) is empty — retryable, and the
// client's cost-aware throttle should mean this is rare in practice, only ever reactive to a
// bucket miscalculation. `ACCESS_DENIED`/`UNAUTHENTICATED` mean the token itself is bad.
// Anything else (a field error, a validation error) is a query bug — retrying an unchanged
// request will not fix it.

import { ApiError } from "../http/errors.ts";

interface ShopifyGraphQlError {
  message?: string;
  extensions?: { code?: string };
}

interface ShopifyGraphQlBody {
  errors?: ShopifyGraphQlError[];
}

function extractErrors(body: unknown): ShopifyGraphQlError[] {
  if (typeof body !== "object" || body === null) return [];
  const errors = (body as ShopifyGraphQlBody).errors;
  return Array.isArray(errors) ? errors : [];
}

export function classifyShopifyError(status: number, body: unknown): ApiError {
  const errors = extractErrors(body);
  const codes = errors
    .map((e) => e.extensions?.code)
    .filter((c): c is string => typeof c === "string");
  const message =
    errors
      .map((e) => e.message)
      .filter(Boolean)
      .join("; ") || `HTTP ${status}`;

  if (status === 401 || codes.includes("UNAUTHENTICATED") || codes.includes("ACCESS_DENIED")) {
    return new ApiError(`Shopify: unauthorized: ${message}`, {
      kind: "unauthorized",
      retryable: false,
      status,
      raw: body,
    });
  }
  if (status === 429 || codes.includes("THROTTLED")) {
    return new ApiError(`Shopify: rate limited: ${message}`, {
      kind: "rate_limited",
      retryable: true,
      status,
      raw: body,
    });
  }
  if (status >= 500) {
    return new ApiError(`Shopify: server error (HTTP ${status}): ${message}`, {
      kind: "server_error",
      retryable: true,
      status,
      raw: body,
    });
  }
  return new ApiError(`Shopify: request failed (HTTP ${status}): ${message}`, {
    kind: "client_error",
    retryable: false,
    status,
    raw: body,
  });
}
