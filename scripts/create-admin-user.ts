// Creates (or resets) a Firebase Auth user for signing into the D6 web app.
//
// The app gates every route behind a valid Firebase ID token (web/server/auth.ts), and
// firestore.rules still denies ALL direct client access - the browser never talks to Firestore,
// only to the API, which uses the Admin SDK. So this user is a login for the UI, not a grant of
// data access.
//
// Run:
//   npx tsx scripts/create-admin-user.ts you@example.com
//   npx tsx scripts/create-admin-user.ts you@example.com --password "your-own-password"
//
// With no --password, a strong one is generated and printed ONCE. It is printed to your
// terminal, so treat it like any other credential: change it after first sign-in if that
// terminal history is shared or logged.

import { randomBytes } from "node:crypto";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { GCP_PROJECT_ID } from "./config.ts";

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"));

function flagValue(flag: string): string | null {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1] ?? null;
}

/** Character set avoids look-alikes (0/O, 1/l/I) so a printed password can be retyped. */
function generatePassword(length = 20): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

async function main() {
  if (!email || !email.includes("@")) {
    console.log("Usage: npx tsx scripts/create-admin-user.ts <email> [--password <pw>]");
    process.exitCode = 1;
    return;
  }
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: GCP_PROJECT_ID });
  }
  const auth = getAuth();
  const password = flagValue("--password") ?? generatePassword();
  const generated = flagValue("--password") === null;

  let uid: string;
  let created: boolean;
  try {
    const existing = await auth.getUserByEmail(email);
    await auth.updateUser(existing.uid, { password, emailVerified: true, disabled: false });
    uid = existing.uid;
    created = false;
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code !== "auth/user-not-found") throw e;
    const user = await auth.createUser({ email, password, emailVerified: true });
    uid = user.uid;
    created = true;
  }

  console.log(`project : ${GCP_PROJECT_ID}`);
  console.log(`${created ? "CREATED" : "PASSWORD RESET FOR"} : ${email}`);
  console.log(`uid     : ${uid}`);
  if (generated) {
    console.log("");
    console.log(`  password: ${password}`);
    console.log("");
    console.log("  Shown once, and printed to this terminal - change it after first sign-in if");
    console.log("  this history is shared. Firebase stores only a hash; it cannot be re-read.");
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e: unknown) => {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
