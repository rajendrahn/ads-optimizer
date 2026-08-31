// B8 live verification: proves `buildCreativeIdentity` (services/ingest/meta/creative/
// identity.ts) against this account's real creative population, without touching Firestore at
// all (production or emulator) and without any mutating Meta call.
//
// Read-only. Makes exactly the same live Meta calls B2's META_SYNC_ENTITIES task already makes
// (`fetchAllCreatives`, a GET) — nothing new, no write of any kind, no archiving. Reuses B2's own
// `normalizeCreative` rather than re-deriving composite detection or hash extraction, matching
// this step's explicit instruction to build on B2's work rather than re-deriving it.
//
// Run: npx tsx scripts/verify-b8-creative-identity.ts
// (Not wired into package.json's scripts — this step's safety constraints forbid touching
// package.json; tsx is already a devDependency, so this runs directly.)

import { createMetaClient } from "../services/ingest/meta/client.ts";
import { fetchAllCreatives } from "../services/ingest/meta/entities/fetch.ts";
import { normalizeCreative } from "../services/ingest/meta/entities/normalize.ts";
import { buildCreativeIdentity } from "../services/ingest/meta/creative/identity.ts";

async function main() {
  console.log("\nB8 creative identity verification (live, read-only)\n" + "-".repeat(60));

  const meta = await createMetaClient();
  const { rows: rawCreatives } = await fetchAllCreatives(meta);
  console.log(`Fetched ${rawCreatives.length} creatives live from the real ad account.`);

  const accountId = "verify-b8-script"; // not written anywhere; normalizeCreative just needs a string
  const syncedAt = new Date();
  const normalized = rawCreatives.map((raw) => normalizeCreative(raw, { accountId, syncedAt }));

  const { assets, families, unidentifiableCreativeIds } = buildCreativeIdentity(normalized);

  const standardFamilies = families.filter((f) => f.creativeType === "STANDARD");
  const compositeFamilies = families.filter((f) => f.creativeType === "COMPOSITE");
  const composites = normalized.filter((c) => c.creativeType === "COMPOSITE");

  const largestFamily = [...standardFamilies].sort(
    (a, b) => (b.variationCount ?? 0) - (a.variationCount ?? 0),
  )[0];

  console.log("-".repeat(60));
  console.log(`metaCreatives (normalized):        ${normalized.length}`);
  console.log(`  STANDARD:                         ${normalized.length - composites.length}`);
  console.log(`  COMPOSITE:                         ${composites.length}`);
  console.log(`Unidentifiable (no hash, STANDARD): ${unidentifiableCreativeIds.length}`);
  console.log("-".repeat(60));
  console.log(`creativeAssets written:             ${assets.length}`);
  console.log(`creativeFamilies written:           ${families.length}`);
  console.log(`  STANDARD families:                 ${standardFamilies.length}`);
  console.log(
    `  COMPOSITE families (excluded from fatigue eligibility): ${compositeFamilies.length}`,
  );
  console.log("-".repeat(60));
  if (largestFamily) {
    console.log(
      `Largest STANDARD family: ${largestFamily.familyId} — ${largestFamily.variationCount} ` +
        `ad-creative object(s) sharing one asset (${largestFamily.memberAssetHashes.length} distinct hash(es))`,
    );
  }
  const eligibleCount = families.filter((f) => f.eligibleForFamilyFatigueScore).length;
  const ineligibleCount = families.length - eligibleCount;
  console.log(
    `eligibleForFamilyFatigueScore: true=${eligibleCount}, false=${ineligibleCount} (should equal COMPOSITE count)`,
  );
  console.log(
    ineligibleCount === compositeFamilies.length
      ? "[PASS] every ineligible family is exactly a composite family"
      : "[FAIL] ineligible count does not match composite family count",
  );
  console.log("-".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("verify-b8-creative-identity failed:", err);
  process.exit(1);
});
