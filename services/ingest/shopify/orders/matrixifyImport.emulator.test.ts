// Emulator-backed proof of B5's "Done when" bar for the Matrixify import: orders older than 60
// days land in Firestore, re-running is a no-op (no duplicates), new-vs-repeat is derived
// correctly, and the gap is recorded loudly in syncState. Every Firestore call is real, against
// the emulator; the CSV "source" is an in-memory fake (csvSource.ts's seam) — no live GCS call.

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../../scripts/config.ts";
import { COLLECTIONS, createRepository, syncStateKey } from "@shared/firestore/index.ts";
import { canonSettingsSchema, resetReportingCanonCacheForTests } from "@shared/canon/index.ts";
import {
  shopifyOrderLineSchema,
  shopifyOrderSchema,
  shopifyRefundSchema,
} from "@shared/schema/index.ts";
import { TEST_CANON } from "../../meta/entities/testFixtures.ts";
import type { RawArchiveStore } from "../../sync/archiver.ts";
import { createTaskRegistry } from "../../sync/registry.ts";
import { createFirestoreSyncStore } from "../../sync/store.ts";
import { runSyncTask } from "../../sync/taskWrapper.ts";
import { createMatrixifyImportHandler, matrixifyImportRegistration } from "./matrixifyImport.ts";
import type { MatrixifyCsvSource } from "./csvSource.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "matrixifyImport.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

const dummyArchiver: RawArchiveStore = {
  archive: async () => ({ path: "unused" }),
  read: async () => undefined,
};

async function cleanupCollections() {
  for (const name of [
    COLLECTIONS.shopifyOrders,
    COLLECTIONS.shopifyOrderLines,
    COLLECTIONS.shopifyRefunds,
    COLLECTIONS.syncState,
    COLLECTIONS.syncRuns,
    COLLECTIONS.settings,
  ]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}

beforeEach(async () => {
  resetReportingCanonCacheForTests();
  await cleanupCollections();
  const settingsRepo = createRepository(db, COLLECTIONS.settings, canonSettingsSchema);
  await settingsRepo.set(TEST_CANON.accountId, TEST_CANON);
});

afterAll(async () => {
  await cleanupCollections();
});

const COLUMNS = [
  "ID",
  "Name",
  "Created At",
  "Updated At",
  "Cancelled At",
  "Cancel: Reason",
  "Currency",
  "Source",
  "Source Identifier",
  "Source URL",
  "Price: Subtotal",
  "Price: Total Discount",
  "Price: Total Shipping",
  "Price: Total Refund",
  "Price: Total",
  "Payment: Status",
  "Customer: ID",
  "Billing: Country Code",
  "Shipping: Country Code",
  "Browser: Landing Page",
  "Browser: Referrer",
  "Browser: Referrer Domain",
  "Browser: Search Keywords",
  "Browser: Ad URL",
  "Browser: UTM Source",
  "Browser: UTM Medium",
  "Browser: UTM Campaign",
  "Browser: UTM Term",
  "Browser: UTM Content",
  "Line: Type",
  "Line: Product ID",
  "Line: Title",
  "Line: Variant ID",
  "Line: SKU",
  "Line: Quantity",
  "Line: Price",
  "Line: Discount",
  "Line: Total",
  "Line: Product Type",
  "Line: Product Tags",
  "Refund: ID",
  "Refund: Created At",
] as const;

type CsvRowInput = Partial<Record<(typeof COLUMNS)[number], string>>;

function csvField(value: string): string {
  return value.includes(",") || value.includes('"') ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildCsvRow(values: CsvRowInput): string {
  return COLUMNS.map((col) => csvField(values[col] ?? "")).join(",");
}

function buildCsv(rows: CsvRowInput[]): string {
  return [COLUMNS.join(","), ...rows.map(buildCsvRow)].join("\n");
}

/** A small, realistic three-order CSV: customer c1's first order (2025-01-15) plus a repeat
 * order (2025-02-01, with a refund), and customer c2's single order — enough to exercise
 * grouping, line/refund extraction and new-vs-repeat in one file. */
const SAMPLE_CSV = buildCsv([
  // order 100: c1's first order — line item row (carries the order-level summary) + shipping.
  {
    ID: "100",
    Name: "#100",
    "Created At": "2025-01-15 14:27:06 +0530",
    "Updated At": "2025-01-15 14:27:06 +0530",
    Currency: "INR",
    "Price: Subtotal": "4580.00",
    "Price: Total Discount": "0.00",
    "Price: Total Shipping": "0.00",
    "Price: Total": "4580.00",
    "Payment: Status": "paid",
    "Customer: ID": "c1",
    "Billing: Country Code": "IN",
    "Shipping: Country Code": "IN",
    "Browser: Landing Page": "/land1",
    "Line: Type": "Line Item",
    "Line: Product ID": "p1",
    "Line: Title": "Necklace",
    "Line: Variant ID": "v1",
    "Line: SKU": "sku1",
    "Line: Quantity": "1",
    "Line: Price": "4580.00",
    "Line: Discount": "0.00",
    "Line: Total": "4580.00",
    "Line: Product Type": "necklace",
    "Line: Product Tags": "gold, wedding",
  },
  {
    ID: "100",
    Name: "#100",
    "Created At": "2025-01-15 14:27:06 +0530",
    "Updated At": "2025-01-15 14:27:06 +0530",
    Currency: "INR",
    "Payment: Status": "paid",
    "Customer: ID": "c1",
    "Billing: Country Code": "IN",
    "Shipping: Country Code": "IN",
    "Browser: Landing Page": "/land1",
    "Line: Type": "Shipping Line",
    "Line: Title": "Standard",
    "Line: Price": "0.00",
    "Line: Total": "0.00",
  },
  // order 101: c1's second (repeat) order — one line item, later refunded.
  {
    ID: "101",
    Name: "#101",
    "Created At": "2025-02-01 10:00:00 +0530",
    "Updated At": "2025-02-05 10:00:00 +0530",
    Currency: "INR",
    "Price: Subtotal": "1000.00",
    "Price: Total Discount": "0.00",
    "Price: Total Shipping": "0.00",
    "Price: Total": "1000.00",
    "Payment: Status": "refunded",
    "Customer: ID": "c1",
    "Billing: Country Code": "IN",
    "Shipping: Country Code": "IN",
    "Line: Type": "Line Item",
    "Line: Product ID": "p2",
    "Line: Title": "Bangle",
    "Line: Variant ID": "v2",
    "Line: SKU": "sku2",
    "Line: Quantity": "1",
    "Line: Price": "1000.00",
    "Line: Discount": "0.00",
    "Line: Total": "1000.00",
    "Line: Product Type": "bangle",
  },
  {
    ID: "101",
    Name: "#101",
    "Created At": "2025-02-01 10:00:00 +0530",
    "Updated At": "2025-02-05 10:00:00 +0530",
    Currency: "INR",
    "Payment: Status": "refunded",
    "Customer: ID": "c1",
    "Billing: Country Code": "IN",
    "Shipping: Country Code": "IN",
    "Line: Type": "Refund Line",
    "Line: Title": "Bangle",
    "Line: Quantity": "-1",
    "Line: Price": "1000.00",
    "Line: Discount": "0.00",
    "Line: Total": "-1000.00",
    "Refund: ID": "r1",
    "Refund: Created At": "2025-02-05 10:00:00 +0530",
  },
  // order 102: c2's single order.
  {
    ID: "102",
    Name: "#102",
    "Created At": "2025-03-01 09:00:00 +0530",
    "Updated At": "2025-03-01 09:00:00 +0530",
    Currency: "INR",
    "Price: Subtotal": "2000.00",
    "Price: Total Discount": "0.00",
    "Price: Total Shipping": "0.00",
    "Price: Total": "2000.00",
    "Payment: Status": "paid",
    "Customer: ID": "c2",
    "Billing: Country Code": "IN",
    "Shipping: Country Code": "IN",
    "Line: Type": "Line Item",
    "Line: Product ID": "p3",
    "Line: Title": "Ring",
    "Line: Variant ID": "v3",
    "Line: SKU": "sku3",
    "Line: Quantity": "1",
    "Line: Price": "2000.00",
    "Line: Discount": "0.00",
    "Line: Total": "2000.00",
    "Line: Product Type": "ring",
  },
]);

function fakeCsvSource(text: string): MatrixifyCsvSource {
  return { read: async () => text };
}

function makeCtx(runId: string) {
  return {
    runId,
    taskType: "SHOPIFY_IMPORT_ORDERS_CSV",
    payload: {},
    archiver: dummyArchiver,
    getMetaClient: async (): Promise<never> => {
      throw new Error("should not be called");
    },
    getShopifyClient: async (): Promise<never> => {
      throw new Error("should not be called");
    },
    recordVersionGuardRejection: () => undefined,
  };
}

describe("matrixifyImportHandler (emulator)", () => {
  it("imports orders/lines/refunds, deriving new-vs-repeat and recording the coverage gap", async () => {
    const handler = createMatrixifyImportHandler(fakeCsvSource(SAMPLE_CSV));
    const result = await handler(makeCtx("run_1"));

    expect(result.newRowCount).toBe(3); // 3 orders
    expect(result.summary).toMatchObject({ ordersWritten: 3, linesWritten: 3, refundsWritten: 1 });
    expect(result.backfillCoverageThroughDate).toBe("2025-03-01");
    expect(result.knownGaps).toHaveLength(1);
    expect(result.knownGaps?.[0].startDate).toBe("2025-03-02");

    const ordersRepo = createRepository(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
    const o100 = await ordersRepo.get("100");
    expect(o100?.totalPriceMinorUnits).toBe(458_000);
    expect(o100?.customerId).toBe("c1");
    expect(o100?.landingSite).toBe("/land1");
    expect(o100?.isNewCustomer).toBe(true); // c1's first order chronologically

    const o101 = await ordersRepo.get("101");
    expect(o101?.isNewCustomer).toBe(false); // c1's second order

    const o102 = await ordersRepo.get("102");
    expect(o102?.isNewCustomer).toBe(true); // c2's only order

    const linesRepo = createRepository(db, COLLECTIONS.shopifyOrderLines, shopifyOrderLineSchema);
    const line100 = await linesRepo.get("100_csvline-1");
    expect(line100?.title).toBe("Necklace");
    expect(line100?.productTags).toEqual(["gold", "wedding"]);
    // The Shipping Line row must NOT have become an order line doc.
    const shippingAsLine = await linesRepo.get("100_csvline-2");
    expect(shippingAsLine).toBeNull();

    const refundsRepo = createRepository(db, COLLECTIONS.shopifyRefunds, shopifyRefundSchema);
    const refund = await refundsRepo.get("101_r1");
    expect(refund?.amountMinorUnits).toBe(100_000);

    const syncStore = createFirestoreSyncStore(db);
    // The handler itself doesn't write syncState (runSyncTask does) — verify via a full
    // runSyncTask pass instead, in the next test.
    void syncStore;
  });

  it("re-running against the SAME file is a no-op — no duplicate docs, no regression", async () => {
    const handler = createMatrixifyImportHandler(fakeCsvSource(SAMPLE_CSV));
    await handler(makeCtx("run_1"));
    const secondResult = await handler(makeCtx("run_2"));

    const orderDocs = await db.collection(COLLECTIONS.shopifyOrders).listDocuments();
    expect(orderDocs).toHaveLength(3);
    const lineDocs = await db.collection(COLLECTIONS.shopifyOrderLines).listDocuments();
    expect(lineDocs).toHaveLength(3);
    const refundDocs = await db.collection(COLLECTIONS.shopifyRefunds).listDocuments();
    expect(refundDocs).toHaveLength(1);

    // Every write on the second pass is an accepted equal-version write, not a rejection.
    expect((secondResult.summary as { versionRejections: number }).versionRejections).toBe(0);
  });

  it("merges in a second, different export file without duplicating the first's orders", async () => {
    const handler1 = createMatrixifyImportHandler(fakeCsvSource(SAMPLE_CSV));
    await handler1(makeCtx("run_1"));

    // A new order (103) for an existing customer (c2) — should resolve as a repeat purchase
    // even though c2's first order was in the first file, proving the recompute is over the
    // full accumulated dataset, not just this run's rows.
    const secondCsv = buildCsv([
      {
        ID: "103",
        Name: "#103",
        "Created At": "2025-04-01 09:00:00 +0530",
        "Updated At": "2025-04-01 09:00:00 +0530",
        Currency: "INR",
        "Price: Subtotal": "500.00",
        "Price: Total Discount": "0.00",
        "Price: Total Shipping": "0.00",
        "Price: Total": "500.00",
        "Payment: Status": "paid",
        "Customer: ID": "c2",
        "Billing: Country Code": "IN",
        "Shipping: Country Code": "IN",
        "Line: Type": "Line Item",
        "Line: Product ID": "p4",
        "Line: Title": "Earring",
        "Line: Variant ID": "v4",
        "Line: SKU": "sku4",
        "Line: Quantity": "1",
        "Line: Price": "500.00",
        "Line: Discount": "0.00",
        "Line: Total": "500.00",
        "Line: Product Type": "earring",
      },
    ]);
    const handler2 = createMatrixifyImportHandler(fakeCsvSource(secondCsv));
    const result2 = await handler2(makeCtx("run_2"));

    expect(result2.summary).toMatchObject({ ordersWritten: 1 });
    const orderDocs = await db.collection(COLLECTIONS.shopifyOrders).listDocuments();
    expect(orderDocs).toHaveLength(4); // 3 from the first file + 1 new, not duplicated

    const ordersRepo = createRepository(db, COLLECTIONS.shopifyOrders, shopifyOrderSchema);
    const o103 = await ordersRepo.get("103");
    expect(o103?.isNewCustomer).toBe(false); // c2 already had order 102
  });

  it("advances syncState.lastDataDate and records knownGaps through the full runSyncTask path", async () => {
    const registry = createTaskRegistry();
    registry.register({
      ...matrixifyImportRegistration,
      handler: createMatrixifyImportHandler(fakeCsvSource(SAMPLE_CSV)),
    });
    const syncStore = createFirestoreSyncStore(db);

    await runSyncTask({
      syncStore,
      registry,
      taskType: "SHOPIFY_IMPORT_ORDERS_CSV",
      payload: {},
      archiver: dummyArchiver,
      taskId: "run_full",
    });

    const state = await syncStore.getSyncState(syncStateKey("shopify", "orders"));
    expect(state?.lastDataDate).toBe("2025-03-01"); // furthest sourceUpdatedAt seen
    expect(state?.backfillCoverageThroughDate).toBe("2025-03-01");
    expect(state?.knownGaps).toHaveLength(1);
    expect(state?.status).toBe("healthy");
  });
});
