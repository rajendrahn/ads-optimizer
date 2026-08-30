import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MetaClient } from "./client.ts";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function noopSleep(): (ms: number) => Promise<void> {
  return vi.fn().mockResolvedValue(undefined);
}

describe("MetaClient.get", () => {
  it("performs a GET with the access token attached and returns the parsed body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: "act_123", name: "Sparkle and Glow" }));
    const client = new MetaClient({ accessToken: "tok-123", fetchImpl, sleepImpl: noopSleep() });

    const result = await client.get<{ id: string; name: string }>("/act_123", {
      fields: "id,name",
    });

    expect(result.data).toEqual({ id: "act_123", name: "Sparkle and Glow" });
    const calledUrl = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("access_token")).toBe("tok-123");
    expect(calledUrl.searchParams.get("fields")).toBe("id,name");
    expect(calledUrl.pathname).toContain("/act_123");
  });

  it("attaches appsecret_proof (HMAC-SHA256 of the token, keyed by the app secret) when an app secret is given", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "act_123" }));
    const client = new MetaClient({
      accessToken: "tok-123",
      appSecret: "shh",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    await client.get("/act_123");

    const calledUrl = new URL(fetchImpl.mock.calls[0][0] as string);
    const expectedProof = createHmac("sha256", "shh").update("tok-123").digest("hex");
    expect(calledUrl.searchParams.get("appsecret_proof")).toBe(expectedProof);
  });

  it("stores the parsed BUC usage from the response for later inspection", async () => {
    const header = JSON.stringify({ act_123: [{ call_count: 42 }] });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ id: "act_123" }, { headers: { "x-business-use-case-usage": header } }),
      );
    const client = new MetaClient({ accessToken: "tok", fetchImpl, sleepImpl: noopSleep() });

    await client.get("/act_123");

    expect(client.getLastUsage()?.maxUsagePercent).toBe(42);
  });

  it("pre-emptively waits before a request when the prior response reported high usage", async () => {
    const highUsageHeader = JSON.stringify({ act_123: [{ call_count: 96 }] });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { id: "act_123" },
          { headers: { "x-business-use-case-usage": highUsageHeader } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "act_123" }));
    const sleepImpl = noopSleep();
    const onThrottle = vi.fn();
    const client = new MetaClient({ accessToken: "tok", fetchImpl, sleepImpl, onThrottle });

    await client.get("/act_123"); // usage comes back at 96% here
    await client.get("/act_123"); // this call should throttle first

    expect(onThrottle).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(expect.any(Number));
  });

  it("does not throttle before the very first request (no usage data yet)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "act_123" }));
    const sleepImpl = noopSleep();
    const client = new MetaClient({ accessToken: "tok", fetchImpl, sleepImpl });

    await client.get("/act_123");

    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("retries a rate-limited error and eventually succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "limited", code: 17 } }, { status: 400 }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "act_123" }));
    const client = new MetaClient({ accessToken: "tok", fetchImpl, sleepImpl: noopSleep() });

    const result = await client.get<{ id: string }>("/act_123");

    expect(result.data.id).toBe("act_123");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unauthorized (code 190) error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { message: "bad token", code: 190 } }, { status: 400 }),
      );
    const client = new MetaClient({ accessToken: "bad-tok", fetchImpl, sleepImpl: noopSleep() });

    await expect(client.get("/act_123")).rejects.toMatchObject({ kind: "unauthorized" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("MetaClient.post", () => {
  it("performs a POST with params, access_token and appsecret_proof in a form-encoded body, not the query string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ report_run_id: "rr_1" }));
    const client = new MetaClient({
      accessToken: "tok-123",
      appSecret: "shh",
      fetchImpl,
      sleepImpl: noopSleep(),
    });

    const result = await client.post<{ report_run_id: string }>("/act_123/insights", {
      level: "ad",
    });

    expect(result.data).toEqual({ report_run_id: "rr_1" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get("access_token")).toBeNull(); // not in the query string
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(body.get("level")).toBe("ad");
    expect(body.get("access_token")).toBe("tok-123");
    const expectedProof = createHmac("sha256", "shh").update("tok-123").digest("hex");
    expect(body.get("appsecret_proof")).toBe(expectedProof);
  });

  it("stores BUC usage from a POST response and pre-emptively throttles the next call", async () => {
    const highUsageHeader = JSON.stringify({ act_123: [{ call_count: 96 }] });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { report_run_id: "rr_1" },
          { headers: { "x-business-use-case-usage": highUsageHeader } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ report_run_id: "rr_2" }));
    const sleepImpl = noopSleep();
    const client = new MetaClient({ accessToken: "tok", fetchImpl, sleepImpl });

    await client.post("/act_123/insights", {});
    await client.post("/act_123/insights", {});

    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limited POST and eventually succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "limited", code: 17 } }, { status: 400 }),
      )
      .mockResolvedValueOnce(jsonResponse({ report_run_id: "rr_1" }));
    const client = new MetaClient({ accessToken: "tok", fetchImpl, sleepImpl: noopSleep() });

    const result = await client.post<{ report_run_id: string }>("/act_123/insights", {});

    expect(result.data.report_run_id).toBe("rr_1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unauthorized POST", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { message: "bad token", code: 190 } }, { status: 400 }),
      );
    const client = new MetaClient({ accessToken: "bad-tok", fetchImpl, sleepImpl: noopSleep() });

    await expect(client.post("/act_123/insights", {})).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("MetaClient.checkAuth", () => {
  it("reports authorized:true on a successful call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: "act_456833154967349" }));
    const client = new MetaClient({ accessToken: "tok", fetchImpl, sleepImpl: noopSleep() });

    const result = await client.checkAuth("act_456833154967349");

    expect(result.authorized).toBe(true);
    expect(result.detail).toContain("act_456833154967349");
  });

  it("reports authorized:false, without throwing, on a code-190 failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: { message: "Error validating access token", code: 190 } },
          { status: 400 },
        ),
      );
    const client = new MetaClient({ accessToken: "bad-tok", fetchImpl, sleepImpl: noopSleep() });

    const result = await client.checkAuth("act_456833154967349");

    expect(result.authorized).toBe(false);
    expect(result.detail).toContain("unauthorized");
  });

  it("propagates a non-auth failure rather than swallowing it as unauthorized", async () => {
    // code 2 ("internal error") retries as server_error until withRetry's default 5 attempts
    // are exhausted, then the final ApiError propagates unchanged — checkAuth only ever
    // downgrades an `unauthorized` classification to a plain result, never anything else.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "boom", code: 2 } }, { status: 500 }));
    const client = new MetaClient({ accessToken: "tok", fetchImpl, sleepImpl: noopSleep() });

    await expect(client.checkAuth("act_456833154967349")).rejects.toMatchObject({
      kind: "server_error",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
