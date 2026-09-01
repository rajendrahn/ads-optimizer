// Pure coverage of verifyAuthHeader's header-parsing branches, against a fake AuthVerifierLike —
// no Auth emulator needed. The real verifier (getAuthVerifier(), backed by a live/emulated
// Firebase Auth project) is proven in web/server/webApi.emulator.test.ts's own "auth" describe
// block, against a real emulator-issued token.

import { describe, expect, it, vi } from "vitest";
import { verifyAuthHeader, type AuthVerifierLike } from "./auth.ts";

function fakeVerifier(result: { uid: string; email?: string | null } | Error): AuthVerifierLike {
  return {
    verifyIdToken: vi.fn(async (token: string) => {
      if (result instanceof Error) throw result;
      expect(token).toBeTruthy();
      return result;
    }),
  };
}

describe("verifyAuthHeader", () => {
  it("returns the decoded user for a valid bearer token", async () => {
    const verifier = fakeVerifier({ uid: "u1", email: "a@example.com" });
    const user = await verifyAuthHeader({ authorization: "Bearer real-token" }, verifier);
    expect(user).toEqual({ uid: "u1", email: "a@example.com" });
  });

  it("defaults email to null when the token carries none", async () => {
    const verifier = fakeVerifier({ uid: "u1" });
    const user = await verifyAuthHeader({ authorization: "Bearer real-token" }, verifier);
    expect(user).toEqual({ uid: "u1", email: null });
  });

  it("returns null when the header is missing", async () => {
    const verifier = fakeVerifier({ uid: "u1" });
    const user = await verifyAuthHeader({}, verifier);
    expect(user).toBeNull();
  });

  it("returns null when the scheme is not Bearer", async () => {
    const verifier = fakeVerifier({ uid: "u1" });
    const user = await verifyAuthHeader({ authorization: "Basic abc123" }, verifier);
    expect(user).toBeNull();
  });

  it("returns null for an empty bearer token", async () => {
    const verifier = fakeVerifier({ uid: "u1" });
    const user = await verifyAuthHeader({ authorization: "Bearer " }, verifier);
    expect(user).toBeNull();
  });

  it("returns null when verifyIdToken throws (expired/invalid/revoked)", async () => {
    const verifier = fakeVerifier(new Error("Firebase ID token has expired"));
    const user = await verifyAuthHeader({ authorization: "Bearer stale-token" }, verifier);
    expect(user).toBeNull();
  });

  it("reads the header case-insensitively (Authorization vs authorization)", async () => {
    const verifier = fakeVerifier({ uid: "u1" });
    const user = await verifyAuthHeader({ Authorization: "Bearer real-token" }, verifier);
    expect(user).toEqual({ uid: "u1", email: null });
  });

  it("handles a header value delivered as an array (Node's raw headers shape)", async () => {
    const verifier = fakeVerifier({ uid: "u1" });
    const user = await verifyAuthHeader({ authorization: ["Bearer real-token"] }, verifier);
    expect(user).toEqual({ uid: "u1", email: null });
  });
});
