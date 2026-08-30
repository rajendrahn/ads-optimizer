import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors.ts";
import { computeBackoffDelayMs, withRetry } from "./retry.ts";

describe("computeBackoffDelayMs", () => {
  it("stays within [0, base * 2^(attempt-1)] before the cap", () => {
    const base = 100;
    const cap = 100_000;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const window = base * 2 ** (attempt - 1);
      for (let i = 0; i < 50; i++) {
        const delay = computeBackoffDelayMs(attempt, base, cap);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(window);
      }
    }
  });

  it("never exceeds maxDelayMs even at a high attempt number", () => {
    const cap = 1000;
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelayMs(20, 500, cap);
      expect(delay).toBeLessThanOrEqual(cap);
    }
  });
});

describe("withRetry", () => {
  function noopSleep(): (ms: number) => Promise<void> {
    return vi.fn().mockResolvedValue(undefined);
  }

  it("returns the result on first success without sleeping", async () => {
    const sleep = noopSleep();
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn, { sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable ApiError and eventually succeeds", async () => {
    const sleep = noopSleep();
    const rateLimited = new ApiError("rate limited", { kind: "rate_limited", retryable: true });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValue("ok");

    const onRetry = vi.fn();
    const result = await withRetry(fn, { sleep, onRetry, maxAttempts: 5 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0].attempt).toBe(1);
    expect(onRetry.mock.calls[1][0].attempt).toBe(2);
  });

  it("does not retry a terminal ApiError", async () => {
    const sleep = noopSleep();
    const unauthorized = new ApiError("bad token", { kind: "unauthorized", retryable: false });
    const fn = vi.fn().mockRejectedValue(unauthorized);

    await expect(withRetry(fn, { sleep })).rejects.toBe(unauthorized);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a client_error ApiError either", async () => {
    const sleep = noopSleep();
    const badRequest = new ApiError("malformed query", { kind: "client_error", retryable: false });
    const fn = vi.fn().mockRejectedValue(badRequest);

    await expect(withRetry(fn, { sleep })).rejects.toBe(badRequest);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("treats a raw (non-ApiError) failure as retryable by default", async () => {
    const sleep = noopSleep();
    const networkFailure = new TypeError("fetch failed");
    const fn = vi.fn().mockRejectedValueOnce(networkFailure).mockResolvedValue("ok");

    const result = await withRetry(fn, { sleep, maxAttempts: 3 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const sleep = noopSleep();
    const serverError = new ApiError("boom", { kind: "server_error", retryable: true });
    const fn = vi.fn().mockRejectedValue(serverError);

    await expect(withRetry(fn, { sleep, maxAttempts: 3 })).rejects.toBe(serverError);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // one fewer sleep than attempts — no sleep after the last
  });

  it("honours a custom isRetryable override", async () => {
    const sleep = noopSleep();
    const err = new Error("custom-classified");
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");

    const result = await withRetry(fn, { sleep, isRetryable: () => true });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
