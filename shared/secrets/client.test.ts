import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __clearSecretCacheForTests,
  __setSecretManagerClientForTests,
  getSecret,
  type SecretManagerClientLike,
} from "./client.ts";

function fakeClient(response: {
  payload?: { data?: Uint8Array | string | null } | null;
}): SecretManagerClientLike & { accessSecretVersion: ReturnType<typeof vi.fn> } {
  return {
    accessSecretVersion: vi.fn().mockResolvedValue([response]),
  };
}

afterEach(() => {
  __setSecretManagerClientForTests(undefined);
});

describe("getSecret", () => {
  it("resolves a secret's latest version and trims whitespace", async () => {
    const client = fakeClient({ payload: { data: "  a-real-token\n" } });
    __setSecretManagerClientForTests(client);

    const value = await getSecret("meta-system-user-token");

    expect(value).toBe("a-real-token");
    expect(client.accessSecretVersion).toHaveBeenCalledWith({
      name: expect.stringContaining("/secrets/meta-system-user-token/versions/latest"),
    });
  });

  it("decodes Buffer/Uint8Array payloads as UTF-8", async () => {
    const client = fakeClient({ payload: { data: Buffer.from("buffer-token", "utf8") } });
    __setSecretManagerClientForTests(client);

    const value = await getSecret("meta-app-secret");

    expect(value).toBe("buffer-token");
  });

  it("caches a resolved secret and does not call Secret Manager again", async () => {
    const client = fakeClient({ payload: { data: "cached-token" } });
    __setSecretManagerClientForTests(client);

    await getSecret("shopify-admin-token");
    await getSecret("shopify-admin-token");

    expect(client.accessSecretVersion).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the cache is cleared", async () => {
    const client = fakeClient({ payload: { data: "token-1" } });
    __setSecretManagerClientForTests(client);
    await getSecret("shopify-webhook-secret");

    __clearSecretCacheForTests();
    client.accessSecretVersion.mockResolvedValue([{ payload: { data: "token-2" } }]);
    const second = await getSecret("shopify-webhook-secret");

    expect(second).toBe("token-2");
    expect(client.accessSecretVersion).toHaveBeenCalledTimes(2);
  });

  it("throws when the secret payload is missing", async () => {
    const client = fakeClient({ payload: null });
    __setSecretManagerClientForTests(client);

    await expect(getSecret("anthropic-api-key")).rejects.toThrow(/empty or missing/);
  });

  it("throws when the secret value is empty or whitespace-only", async () => {
    const client = fakeClient({ payload: { data: "   " } });
    __setSecretManagerClientForTests(client);

    await expect(getSecret("anthropic-api-key")).rejects.toThrow(/empty or missing/);
  });

  it("keys the cache by project id, so the same name under a different project re-fetches", async () => {
    const client = fakeClient({ payload: { data: "project-a-value" } });
    __setSecretManagerClientForTests(client);

    await getSecret("meta-app-secret", { projectId: "project-a" });
    client.accessSecretVersion.mockResolvedValue([{ payload: { data: "project-b-value" } }]);
    const valueB = await getSecret("meta-app-secret", { projectId: "project-b" });

    expect(valueB).toBe("project-b-value");
    expect(client.accessSecretVersion).toHaveBeenCalledTimes(2);
  });
});
