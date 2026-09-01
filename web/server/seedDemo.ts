// D6 — seeds the Firestore + Auth emulators with a small, synthetic account (demoFixtures.ts) so
// an operator can run the web app locally end to end without touching production data or making a
// live Anthropic call. Run via `npm run seed:web-demo`
// (`firebase emulators:exec --only firestore,auth "tsx web/server/seedDemo.ts"`) — mirrors B1's
// own `verify-*` scripts.
//
// Every id involved is synthetic (`AS_17`, `cmp_1`, ...) — see demoFixtures.ts's own
// `DEMO_ENTITIES` map for what each one demonstrates (EVIDENCE / NOT_DELIVERING /
// NO_DECISION_UNIT / escalation / FAILED / REJECTED). No real Meta/Shopify identifier appears
// anywhere in this file, per this step's constraint on fixtures.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { GCP_PROJECT_ID, META_AD_ACCOUNT_ID } from "../../scripts/config.ts";
import { resetReportingCanonCacheForTests } from "../../shared/canon/index.ts";
import { seedDemoAccount } from "./demoFixtures.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "seedDemo.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run seed:web-demo`.",
  );
}
if (getApps().length === 0) initializeApp({ projectId: GCP_PROJECT_ID });
const db: Firestore = getFirestore();

async function seedAuthUser(): Promise<{ email: string; password: string }> {
  const email = "rajendrahn38@gmail.com";
  const password = "demo-password-local-only";
  try {
    await getAuth().createUser({ email, password, emailVerified: true });
    console.log(`[seedDemo] created Auth emulator user ${email}`);
  } catch (err) {
    const code = (err as { errorInfo?: { code?: string } })?.errorInfo?.code;
    if (code === "auth/email-already-exists") {
      console.log(`[seedDemo] Auth emulator user ${email} already exists`);
    } else {
      throw err;
    }
  }
  return { email, password };
}

async function main(): Promise<void> {
  resetReportingCanonCacheForTests();
  await seedDemoAccount(db, META_AD_ACCOUNT_ID);
  const user = await seedAuthUser();

  console.log("\n[seedDemo] done. Entities to ask about in the web app:");
  console.log("  ADSET AS_17        — healthy volume, eligible -> INCREASE_BUDGET (EVIDENCE)");
  console.log("  ADSET AS_dead      — zero delivery -> NOT_DELIVERING");
  console.log("  CAMPAIGN cmp_orphan — no budget, no ad sets -> NO_DECISION_UNIT");
  console.log("  AD ad_lowvol       — escalates to AS_17 (SAMPLE_TOO_SMALL)");
  console.log("  ADSET AS_faildemo  — the demo reasoner throws -> FAILED");
  console.log("  ADSET AS_overlimit — the real D5 guardrail rejects a large change -> REJECTED");
  console.log(`\n[seedDemo] sign in at the web app with: ${user.email} / ${user.password}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[seedDemo] failed", err);
    process.exit(1);
  });
