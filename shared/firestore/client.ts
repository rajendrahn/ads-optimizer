// Lazy singleton Admin SDK Firestore client.
//
// Deliberately NOT called at module load anywhere else in shared/firestore or shared/schema
// — repository.ts and versionGuard.ts both take a `Firestore` instance as a parameter
// instead of importing getDb() themselves, so plain unit tests (schema parsing, key
// helpers, version-guard decision logic) never construct a real client or touch
// credentials/emulator state. Only real runtime callers (later steps' services/, and the
// emulator-backed integration tests) call this.
//
// Picks up FIRESTORE_EMULATOR_HOST automatically — that's the Admin SDK's own behaviour,
// nothing special done here. GCP_PROJECT_ID is imported from scripts/config.ts (A0/A1's
// existing home for these non-secret IDs) rather than duplicated here.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { GCP_PROJECT_ID } from "../../scripts/config.ts";

let cached: Firestore | null = null;

export function getDb(): Firestore {
  if (cached) return cached;
  if (getApps().length === 0) {
    initializeApp({ projectId: GCP_PROJECT_ID });
  }
  cached = getFirestore();
  return cached;
}
