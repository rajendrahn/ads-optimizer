// D6 — Firebase client SDK usage, deliberately Auth-only. This file (and this app) must never
// import `firebase/firestore` — §17.1 requires all data to be served through the API, and
// web/eslint.config.js's `no-restricted-imports` rule enforces that structurally, not just by
// convention. See web/server/server.ts's module comment for the full write-up of why live status
// is an SSE stream from this API rather than a client-side `onSnapshot`.
//
// Config is read from Vite env vars (`import.meta.env.VITE_FIREBASE_*`, set via `web/.env.local`
// for local dev — see README-level "how to run this locally" notes in this step's report). When
// `VITE_USE_AUTH_EMULATOR=1` (the default for local dev against `firebase emulators:start`), this
// connects to the Auth emulator instead of a real Firebase project.

import { initializeApp, type FirebaseOptions } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";

const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "demo-api-key",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "sng-meta-ads-optimizer",
};

const app = initializeApp(firebaseConfig);
export const auth: Auth = getAuth(app);

let emulatorConnected = false;
if (import.meta.env.VITE_USE_AUTH_EMULATOR === "1" && !emulatorConnected) {
  const host = import.meta.env.VITE_AUTH_EMULATOR_HOST ?? "http://127.0.0.1:9099";
  connectAuthEmulator(auth, host, { disableWarnings: true });
  emulatorConnected = true;
}
