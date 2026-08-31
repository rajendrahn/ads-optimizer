// Emulator-backed proof of `seasonalityContextFor` end to end: real Firestore reads across
// `seasonalCalendarWindows`, `shopifyOrdersNormalized` and `shopifyDailyCoverage`, exercising
// exactly the fixed interface contract (labels, spansSeasonalBoundary, demandIndex,
// demandIndexSampleSize, summaryText).

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../../../scripts/config.ts";
import { COLLECTIONS } from "@shared/firestore/index.ts";
import type {
  ReportingDay,
  SeasonalCalendarWindow,
  ShopifyOrderNormalized,
} from "@shared/schema/index.ts";
import { addCalendarDays } from "@shared/canon/index.ts";
import { seasonalityContextFor } from "./context.ts";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "context.emulator.test.ts requires FIRESTORE_EMULATOR_HOST — run via `npm run test:integration`.",
  );
}
if (getApps().length === 0) {
  initializeApp({ projectId: GCP_PROJECT_ID });
}
const db: Firestore = getFirestore();

async function cleanup() {
  for (const name of [
    COLLECTIONS.seasonalCalendarWindows,
    COLLECTIONS.shopifyOrdersNormalized,
    COLLECTIONS.shopifyDailyCoverage,
  ]) {
    const snaps = await db.collection(name).listDocuments();
    await Promise.all(snaps.map((ref) => ref.delete()));
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function seedWindow(label: string, startDay: ReportingDay, endDay: ReportingDay) {
  const doc: SeasonalCalendarWindow = {
    label,
    startDay,
    endDay,
    year: Number(startDay.slice(0, 4)),
    confidence: "confirmed",
    source: "test fixture",
    notes: null,
    sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    computedAt: new Date("2026-01-01T00:00:00Z"),
  };
  await db.collection(COLLECTIONS.seasonalCalendarWindows).doc(`${label}_${startDay}`).set(doc);
}

let orderCounter = 0;
async function seedOrder(day: ReportingDay, revenueMinorUnits: number) {
  orderCounter++;
  const doc: ShopifyOrderNormalized = {
    orderId: `order_${orderCounter}`,
    reportingDay: day,
    reportingTimezone: "Asia/Kolkata",
    nativeCreatedAt: new Date(`${day}T10:00:00Z`),
    totalPrice: {
      amountMinorUnits: revenueMinorUnits,
      currency: "INR",
      sourceAmountMinorUnits: revenueMinorUnits,
      sourceCurrency: "INR",
      fxRateToReportingCurrency: 1,
      fxRateSource: "same_currency_no_conversion",
    },
    subtotalPrice: {
      amountMinorUnits: revenueMinorUnits,
      currency: "INR",
      sourceAmountMinorUnits: revenueMinorUnits,
      sourceCurrency: "INR",
      fxRateToReportingCurrency: 1,
      fxRateSource: "same_currency_no_conversion",
    },
    totalDiscounts: {
      amountMinorUnits: 0,
      currency: "INR",
      sourceAmountMinorUnits: 0,
      sourceCurrency: "INR",
      fxRateToReportingCurrency: 1,
      fxRateSource: "same_currency_no_conversion",
    },
    totalShipping: null,
    isNewCustomer: null,
    country: "IN",
    customerId: `synthetic_customer_${orderCounter}`,
    resolvedAdId: null,
    resolvedCampaignId: null,
    source: "GRAPHQL_SYNC",
    sourceUpdatedAt: new Date(`${day}T10:00:00Z`),
    computedAt: new Date(),
  };
  await db.collection(COLLECTIONS.shopifyOrdersNormalized).doc(doc.orderId).set(doc);
}

async function seedCoverageRange(fromDay: ReportingDay, toDay: ReportingDay, hasGap: boolean) {
  const batch = db.batch();
  for (let day = fromDay; day <= toDay; day = addCalendarDays(day, 1)) {
    batch.set(db.collection(COLLECTIONS.shopifyDailyCoverage).doc(day), {
      reportingDay: day,
      reportingTimezone: "Asia/Kolkata",
      accountId: GCP_PROJECT_ID,
      hasCoverageGap: hasGap,
      gapReason: hasGap ? "test gap" : null,
      ordersObserved: 0,
      refundsObserved: 0,
      computedAt: new Date(),
      sourceUpdatedAt: new Date(),
    });
  }
  await batch.commit();
}

describe("seasonalityContextFor (emulator)", () => {
  it("an off-season window: empty labels, demandIndex 1.0 by definition, no baseline given", async () => {
    await seedWindow("diwali", "2025-10-19", "2025-10-23");
    const result = await seasonalityContextFor({ startDay: "2025-06-01", endDay: "2025-06-28" });

    expect(result.labels).toEqual([]);
    expect(result.spansSeasonalBoundary).toBe(false);
    expect(result.demandIndex).toBe(1);
    expect(result.demandIndexSampleSize).toBe(0);
    expect(result.summaryText).toContain("off-season");
  });

  it("a window covering a real label with exactly ONE clean historical occurrence: labels present, demandIndex null (n=1)", async () => {
    await seedWindow("diwali", "2025-10-19", "2025-10-23");
    await seedCoverageRange("2025-09-01", "2025-10-23", false);
    for (
      let day = "2025-09-01" as ReportingDay;
      day <= "2025-10-18";
      day = addCalendarDays(day, 1)
    ) {
      await seedOrder(day, 100000);
    }
    for (
      let day = "2025-10-19" as ReportingDay;
      day <= "2025-10-23";
      day = addCalendarDays(day, 1)
    ) {
      await seedOrder(day, 500000); // a real 5x lift, still honestly reported as null at n=1
    }

    const result = await seasonalityContextFor({ startDay: "2025-10-19", endDay: "2025-10-23" });

    expect(result.labels).toEqual(["diwali"]);
    expect(result.demandIndex).toBeNull();
    expect(result.demandIndexSampleSize).toBe(1);
    expect(result.summaryText).toContain("Diwali");
    expect(result.summaryText.toLowerCase()).toContain("n=1");
  });

  it("the honesty-critical case: an occurrence entirely inside the Shopify data gap yields demandIndex null, sampleSize 0 — never a number computed by averaging across the hole", async () => {
    await seedWindow("diwali", "2025-10-19", "2025-10-23");
    // Mark the occurrence's own days as a coverage gap — simulating B5's real
    // 2025-12-14 -> ~2026-07-02 hole landing on a festive window.
    await seedCoverageRange("2025-10-19", "2025-10-23", true);
    await seedCoverageRange("2025-09-01", "2025-10-18", false);
    for (
      let day = "2025-09-01" as ReportingDay;
      day <= "2025-10-18";
      day = addCalendarDays(day, 1)
    ) {
      await seedOrder(day, 100000);
    }
    // Even if a (bogus, gap-period) order exists, it must never be counted.
    await seedOrder("2025-10-20" as ReportingDay, 999999999);

    const result = await seasonalityContextFor({ startDay: "2025-10-19", endDay: "2025-10-23" });

    expect(result.labels).toEqual(["diwali"]);
    expect(result.demandIndex).toBeNull();
    expect(result.demandIndexSampleSize).toBe(0);
  });

  it("two clean historical occurrences: demandIndex becomes a real number", async () => {
    await seedWindow("diwali", "2025-10-19", "2025-10-23");
    await seedWindow("diwali", "2026-11-07", "2026-11-10");
    await seedCoverageRange("2025-09-01", "2025-10-23", false);
    await seedCoverageRange("2026-09-01", "2026-11-10", false);
    for (
      let day = "2025-09-01" as ReportingDay;
      day <= "2025-10-18";
      day = addCalendarDays(day, 1)
    ) {
      await seedOrder(day, 100000);
    }
    for (
      let day = "2025-10-19" as ReportingDay;
      day <= "2025-10-23";
      day = addCalendarDays(day, 1)
    ) {
      await seedOrder(day, 200000);
    }
    for (
      let day = "2026-09-01" as ReportingDay;
      day <= "2026-11-06";
      day = addCalendarDays(day, 1)
    ) {
      await seedOrder(day, 150000);
    }
    for (
      let day = "2026-11-07" as ReportingDay;
      day <= "2026-11-10";
      day = addCalendarDays(day, 1)
    ) {
      await seedOrder(day, 300000);
    }

    const result = await seasonalityContextFor({ startDay: "2025-10-19", endDay: "2025-10-23" });

    expect(result.demandIndexSampleSize).toBe(2);
    expect(result.demandIndex).not.toBeNull();
    expect(result.demandIndex).toBeCloseTo(2, 1);
    expect(result.summaryText).toContain("2.00x");
  });

  it("spansSeasonalBoundary: true when window and baseline sit in different regimes", async () => {
    await seedWindow("diwali", "2025-10-19", "2025-10-23");

    const result = await seasonalityContextFor(
      { startDay: "2025-10-19", endDay: "2025-10-23" },
      { startDay: "2025-06-01", endDay: "2025-06-28" }, // off-season baseline
    );

    expect(result.labels).toEqual(["diwali"]);
    expect(result.spansSeasonalBoundary).toBe(true);
    expect(result.summaryText).toContain("Diwali");
    expect(result.summaryText).toContain("baseline is off-season");
  });

  it("spansSeasonalBoundary: false when window and baseline are both off-season", async () => {
    await seedWindow("diwali", "2025-10-19", "2025-10-23");

    const result = await seasonalityContextFor(
      { startDay: "2025-06-01", endDay: "2025-06-28" },
      { startDay: "2025-07-01", endDay: "2025-07-28" },
    );

    expect(result.spansSeasonalBoundary).toBe(false);
  });

  it("multiple overlapping labels, e.g. wedding_season + dhanteras — matches the interface's own documented example shape", async () => {
    await seedWindow("dhanteras", "2025-10-17", "2025-10-18");
    await seedWindow("wedding_season", "2025-09-01", "2026-02-15");

    const result = await seasonalityContextFor({ startDay: "2025-10-17", endDay: "2025-10-18" });

    expect(result.labels).toEqual(["dhanteras", "wedding_season"]);
  });
});
