// Where MATRIXIFY_IMPORT reads the Matrixify export from — the restricted PII bucket (SETUP.md
// §3), never the general raw archive bucket and never the repo. `MatrixifyCsvSource` is a
// narrow structural interface (same seam pattern as A2's `VersionGuardFirestoreLike`, A4's
// `SecretManagerClientLike`, B1's `StorageBucketLike`) so the real Cloud Storage read path is
// exercised by unit tests against a hand-rolled fake, with no live bucket touched by `npm run
// test`/`npm run check` — matching this step's safety constraints (no cloud resource created,
// modified, or read as part of automated verification; the local scratchpad copy of the real
// export stands in for it instead).

import { Storage } from "@google-cloud/storage";
import {
  SHOPIFY_MATRIXIFY_DEFAULT_OBJECT_KEY,
  SHOPIFY_PII_IMPORT_BUCKET,
} from "../../../../scripts/config.ts";

export interface MatrixifyCsvSource {
  /** Reads the named object's full contents as UTF-8 text. `objectKey` defaults to
   * `SHOPIFY_MATRIXIFY_DEFAULT_OBJECT_KEY` at the call site (matrixifyImport.ts), not here —
   * this interface stays a plain "read this key" contract so a caller can point it at a
   * different export file (see module comment: B5's importer must accept more than one). */
  read(objectKey: string): Promise<string>;
}

/** The narrow slice of `@google-cloud/storage`'s `File` this module actually calls — a real
 * `Bucket` satisfies `GcsMatrixifyCsvSource`'s needs structurally, no adapter needed. */
export interface CsvStorageFileLike {
  download(): Promise<[Buffer]>;
}
export interface CsvStorageBucketLike {
  file(name: string): CsvStorageFileLike;
}

export class GcsMatrixifyCsvSource implements MatrixifyCsvSource {
  constructor(private readonly bucket: CsvStorageBucketLike) {}

  async read(objectKey: string): Promise<string> {
    const [buf] = await this.bucket.file(objectKey).download();
    return buf.toString("utf8");
  }
}

/** Real bucket, resolved from the fixed name in scripts/config.ts. Not called anywhere in this
 * step's own tests — see module comment. */
export function createDefaultMatrixifyCsvSource(): GcsMatrixifyCsvSource {
  return new GcsMatrixifyCsvSource(new Storage().bucket(SHOPIFY_PII_IMPORT_BUCKET));
}

export { SHOPIFY_MATRIXIFY_DEFAULT_OBJECT_KEY };
