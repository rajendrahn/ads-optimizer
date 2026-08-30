// The thin repository layer: typed get/set/query per collection, no business logic.
//
// Built on a Firestore `withConverter`, so callers get the native Admin SDK query API
// (`.where().orderBy().limit()`, transactions, batched writes, ...) fully typed, rather than
// a bespoke query DSL this file would have to keep growing to cover. `collectionRef` is the
// primitive; `createRepository` wraps it with the handful of operations every collection
// needs, validating with the collection's zod schema on the way in and out so a malformed
// document fails loudly at the write/read boundary instead of silently drifting.

import type {
  CollectionReference,
  DocumentData,
  Firestore,
  Query,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import type { ZodType } from "zod";

/**
 * A typed collection reference: reads run every document through `schema.parse`, writes run
 * the model through it before Firestore ever sees it. Use this directly when a caller needs
 * more than get/set/query — e.g. a transaction or a batched write — since it composes with
 * the rest of the Admin SDK exactly like an unconverted `CollectionReference` would.
 */
export function collectionRef<T>(
  db: Firestore,
  collectionName: string,
  schema: ZodType<T>,
): CollectionReference<T, DocumentData> {
  return db.collection(collectionName).withConverter<T>({
    toFirestore(model: T): DocumentData {
      return schema.parse(model) as DocumentData;
    },
    fromFirestore(snapshot: QueryDocumentSnapshot): T {
      return schema.parse(snapshot.data());
    },
  });
}

export interface Repository<T> {
  /** The typed, converter-wrapped collection reference — for anything beyond get/set/query. */
  ref: CollectionReference<T, DocumentData>;
  /** Returns `null` when the document does not exist, rather than throwing. */
  get(id: string): Promise<T | null>;
  /** Full-document overwrite, validated against the collection's schema. Not a merge. */
  set(id: string, data: T): Promise<void>;
  /** Compose a query against the typed collection ref, then fetch and parse every result. */
  query(build: (ref: CollectionReference<T, DocumentData>) => Query<T, DocumentData>): Promise<T[]>;
}

/** A thin, typed get/set/query wrapper for one collection. No business logic. */
export function createRepository<T>(
  db: Firestore,
  collectionName: string,
  schema: ZodType<T>,
): Repository<T> {
  const ref = collectionRef(db, collectionName, schema);

  return {
    ref,
    async get(id: string): Promise<T | null> {
      const snap = await ref.doc(id).get();
      return snap.exists ? (snap.data() as T) : null;
    },
    async set(id: string, data: T): Promise<void> {
      await ref.doc(id).set(data);
    },
    async query(build): Promise<T[]> {
      const snap = await build(ref).get();
      return snap.docs.map((d) => d.data());
    },
  };
}
