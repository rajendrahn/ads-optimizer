import { describe, expect, it } from "vitest";
import { classifyMetaError } from "./errors.ts";

describe("classifyMetaError", () => {
  it("classifies code 190 (OAuthException) as unauthorized, terminal", () => {
    const err = classifyMetaError(400, {
      error: { message: "Error validating access token", type: "OAuthException", code: 190 },
    });
    expect(err.kind).toBe("unauthorized");
    expect(err.retryable).toBe(false);
  });

  it.each([4, 17, 32, 613])("classifies code %d as rate_limited, retryable", (code) => {
    const err = classifyMetaError(400, { error: { message: "limited", code } });
    expect(err.kind).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("falls back to HTTP 401/403 for unauthorized when there's no recognized code", () => {
    expect(classifyMetaError(401, {}).kind).toBe("unauthorized");
    expect(classifyMetaError(403, {}).kind).toBe("unauthorized");
    expect(classifyMetaError(401, {}).retryable).toBe(false);
  });

  it("falls back to HTTP 429 for rate_limited when there's no recognized code", () => {
    const err = classifyMetaError(429, {});
    expect(err.kind).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("classifies 5xx as server_error, retryable", () => {
    const err = classifyMetaError(500, { error: { message: "internal", code: 2 } });
    expect(err.kind).toBe("server_error");
    expect(err.retryable).toBe(true);
  });

  it("classifies an unrecognized 4xx as client_error, terminal", () => {
    const err = classifyMetaError(400, { error: { message: "bad param", code: 100 } });
    expect(err.kind).toBe("client_error");
    expect(err.retryable).toBe(false);
  });

  it("handles a body with no error object at all (e.g. an unparseable/empty response)", () => {
    const err = classifyMetaError(500, undefined);
    expect(err.kind).toBe("server_error");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("HTTP 500");
  });

  it("keeps the raw body attached for debugging", () => {
    const body = { error: { message: "x", code: 190 } };
    const err = classifyMetaError(400, body);
    expect(err.raw).toBe(body);
    expect(err.status).toBe(400);
  });
});
