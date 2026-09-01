// D6 — Firebase Auth verification, the API's own gate. §17.1 requires "all data served through
// the API"; this is what makes that true for reads as well as writes (see server.ts's module
// comment for the full resolution of the onSnapshot-vs-§17.1 contradiction the step brief flags).
//
// Every route below AuthenticatedUser requires a valid Firebase ID token in
// `Authorization: Bearer <token>` — never a session cookie, never a client-supplied uid. A
// missing/invalid/expired token is a 401, uniformly, before any handler-specific logic runs.

import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";

export interface AuthenticatedUser {
  uid: string;
  email: string | null;
}

/** The narrow slice of `firebase-admin/auth`'s `Auth` this module actually calls — a real `Auth`
 * satisfies this structurally (same seam pattern as A2's `VersionGuardFirestoreLike`/A4's
 * `SecretManagerClientLike`), so a unit test can inject a fake verifier without a running Auth
 * emulator, while `getAuthVerifier()` below hands routes the real thing. */
export interface AuthVerifierLike {
  verifyIdToken(idToken: string): Promise<{ uid: string; email?: string | null }>;
}

let cachedVerifier: AuthVerifierLike | undefined;

/** Lazily initializes the one Admin SDK app this process needs (shared with
 * `@shared/firestore/index.ts`'s `getDb()` — `getApps().length === 0` is the same guard that file
 * uses, so calling this before or after `getDb()` never creates a second app) and returns the real
 * `Auth` instance. Picks up `FIREBASE_AUTH_EMULATOR_HOST` automatically, exactly like `getDb()`
 * picks up `FIRESTORE_EMULATOR_HOST` — nothing special done here. */
export function getAuthVerifier(): AuthVerifierLike {
  if (cachedVerifier) return cachedVerifier;
  if (getApps().length === 0) {
    initializeApp({ projectId: GCP_PROJECT_ID });
  }
  cachedVerifier = getAuth();
  return cachedVerifier;
}

/** Test-only: clears the cached verifier so a test can inject a fresh fake. */
export function __resetAuthVerifierForTests(): void {
  cachedVerifier = undefined;
}

/** Extracts and verifies the bearer token from a plain header map. Returns `null` on anything
 * short of a fully valid token — missing header, wrong scheme, empty token, or a token
 * `verifyIdToken` itself rejects (expired, wrong project, malformed, revoked). Never throws —
 * callers branch on `null` to return 401, uniformly. */
export async function verifyAuthHeader(
  headers: Record<string, string | string[] | undefined>,
  verifier: AuthVerifierLike,
): Promise<AuthenticatedUser | null> {
  const raw = headers["authorization"] ?? headers["Authorization"];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  if (!headerValue || !headerValue.startsWith("Bearer ")) return null;
  const token = headerValue.slice("Bearer ".length).trim();
  if (token.length === 0) return null;
  try {
    const decoded = await verifier.verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch {
    return null;
  }
}
