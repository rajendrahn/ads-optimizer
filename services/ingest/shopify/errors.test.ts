import { describe, expect, it } from "vitest";
import { classifyShopifyError } from "./errors.ts";

describe("classifyShopifyError", () => {
  it("classifies extensions.code THROTTLED as rate_limited, retryable", () => {
    const err = classifyShopifyError(200, {
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
    });
    expect(err.kind).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it.each(["ACCESS_DENIED", "UNAUTHENTICATED"])(
    "classifies extensions.code %s as unauthorized, terminal",
    (code) => {
      const err = classifyShopifyError(200, { errors: [{ message: "no", extensions: { code } }] });
      expect(err.kind).toBe("unauthorized");
      expect(err.retryable).toBe(false);
    },
  );

  it("classifies HTTP 401 as unauthorized even without a GraphQL error body", () => {
    const err = classifyShopifyError(401, {});
    expect(err.kind).toBe("unauthorized");
    expect(err.retryable).toBe(false);
  });

  it("classifies HTTP 429 as rate_limited even without a GraphQL error body", () => {
    const err = classifyShopifyError(429, {});
    expect(err.kind).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("classifies 5xx as server_error, retryable", () => {
    const err = classifyShopifyError(503, {});
    expect(err.kind).toBe("server_error");
    expect(err.retryable).toBe(true);
  });

  it("classifies an unrecognized GraphQL error (e.g. a field/validation error) as client_error, terminal", () => {
    const err = classifyShopifyError(200, {
      errors: [{ message: "Field 'bogus' doesn't exist on type 'Shop'" }],
    });
    expect(err.kind).toBe("client_error");
    expect(err.retryable).toBe(false);
  });

  it("handles a body with no errors array at all", () => {
    const err = classifyShopifyError(500, undefined);
    expect(err.kind).toBe("server_error");
    expect(err.message).toContain("HTTP 500");
  });
});
