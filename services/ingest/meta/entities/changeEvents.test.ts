// Pure unit tests for diffEntitySnapshots — B4's own "Done when" bar: "a simulated budget
// edit between two snapshots produces exactly one correctly typed change event, and an
// unchanged snapshot pair produces none. Test both directions explicitly." No Firestore, no
// emulator — see changeEvents.emulator.test.ts for the write-path/orchestration coverage.

import { describe, expect, it } from "vitest";
import type { BudgetOwnership, MetaEntitySnapshot } from "@shared/schema/index.ts";
import { diffEntitySnapshots } from "./changeEvents.ts";

const OPTS = {
  fromSnapshotKey: "ADSET_as_1_run_1",
  toSnapshotKey: "ADSET_as_1_run_2",
  detectedAt: new Date("2026-08-30T00:00:00Z"),
};

function budget(overrides: Partial<BudgetOwnership> = {}): BudgetOwnership {
  return {
    ownerLevel: "ADSET",
    dailyBudgetMinorUnits: 50000,
    lifetimeBudgetMinorUnits: null,
    currency: "INR",
    ...overrides,
  };
}

function snapshot(overrides: Partial<MetaEntitySnapshot> = {}): MetaEntitySnapshot {
  return {
    entityType: "ADSET",
    entityId: "as_1",
    syncRunId: "run_1",
    takenAt: new Date("2026-08-29T00:00:00Z"),
    budget: budget(),
    status: "ACTIVE",
    targeting: { publisher_platforms: ["facebook"] },
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    creativeAssignment: null,
    ...overrides,
  };
}

describe("diffEntitySnapshots", () => {
  it("returns [] when there is no previous snapshot to diff against", () => {
    expect(diffEntitySnapshots(null, snapshot(), OPTS)).toEqual([]);
  });

  it("an unchanged snapshot pair produces no events", () => {
    const previous = snapshot();
    const current = snapshot();
    expect(diffEntitySnapshots(previous, current, OPTS)).toEqual([]);
  });

  it("a budget INCREASE produces exactly one correctly typed BUDGET event", () => {
    const previous = snapshot({ budget: budget({ dailyBudgetMinorUnits: 50000 }) });
    const current = snapshot({ budget: budget({ dailyBudgetMinorUnits: 60000 }) });

    const events = diffEntitySnapshots(previous, current, OPTS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityType: "ADSET",
      entityId: "as_1",
      field: "BUDGET",
      fromSnapshotKey: OPTS.fromSnapshotKey,
      toSnapshotKey: OPTS.toSnapshotKey,
      detectedAt: OPTS.detectedAt,
      before: budget({ dailyBudgetMinorUnits: 50000 }),
      after: budget({ dailyBudgetMinorUnits: 60000 }),
      budgetChangePercent: 20,
      actor: null,
    });
  });

  it("a budget DECREASE produces exactly one correctly typed BUDGET event (both directions covered)", () => {
    const previous = snapshot({ budget: budget({ dailyBudgetMinorUnits: 60000 }) });
    const current = snapshot({ budget: budget({ dailyBudgetMinorUnits: 50000 }) });

    const events = diffEntitySnapshots(previous, current, OPTS);

    expect(events).toHaveLength(1);
    expect(events[0].field).toBe("BUDGET");
    expect(events[0].budgetChangePercent).toBeCloseTo(-16.67, 2);
    expect(events[0].before).toEqual(budget({ dailyBudgetMinorUnits: 60000 }));
    expect(events[0].after).toEqual(budget({ dailyBudgetMinorUnits: 50000 }));
  });

  it("falls back to lifetimeBudgetMinorUnits for the percent when daily is absent on both sides", () => {
    const previous = snapshot({
      budget: budget({ dailyBudgetMinorUnits: null, lifetimeBudgetMinorUnits: 100000 }),
    });
    const current = snapshot({
      budget: budget({ dailyBudgetMinorUnits: null, lifetimeBudgetMinorUnits: 150000 }),
    });

    const events = diffEntitySnapshots(previous, current, OPTS);

    expect(events).toHaveLength(1);
    expect(events[0].budgetChangePercent).toBe(50);
  });

  it("a STATUS change produces exactly one correctly typed STATUS event", () => {
    const previous = snapshot({ status: "ACTIVE" });
    const current = snapshot({ status: "PAUSED" });

    const events = diffEntitySnapshots(previous, current, OPTS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ field: "STATUS", before: "ACTIVE", after: "PAUSED" });
  });

  it("a TARGETING change produces exactly one correctly typed TARGETING event", () => {
    const previous = snapshot({ targeting: { publisher_platforms: ["facebook"] } });
    const current = snapshot({ targeting: { publisher_platforms: ["facebook", "instagram"] } });

    const events = diffEntitySnapshots(previous, current, OPTS);

    expect(events).toHaveLength(1);
    expect(events[0].field).toBe("TARGETING");
  });

  it("targeting key reordering alone (same object, different key order) is not a change", () => {
    const previous = snapshot({ targeting: { a: 1, b: 2 } });
    const current = snapshot({ targeting: { b: 2, a: 1 } });

    expect(diffEntitySnapshots(previous, current, OPTS)).toEqual([]);
  });

  it("a BID_STRATEGY change produces exactly one correctly typed BID_STRATEGY event", () => {
    const previous = snapshot({ bidStrategy: "LOWEST_COST_WITHOUT_CAP" });
    const current = snapshot({ bidStrategy: "COST_CAP" });

    const events = diffEntitySnapshots(previous, current, OPTS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      field: "BID_STRATEGY",
      before: "LOWEST_COST_WITHOUT_CAP",
      after: "COST_CAP",
    });
  });

  it("a CREATIVE_ASSIGNMENT change produces exactly one correctly typed event", () => {
    const previous = snapshot({ entityType: "AD", creativeAssignment: ["cr_1"] });
    const current = snapshot({ entityType: "AD", creativeAssignment: ["cr_2"] });

    const events = diffEntitySnapshots(previous, current, OPTS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      field: "CREATIVE_ASSIGNMENT",
      before: ["cr_1"],
      after: ["cr_2"],
    });
  });

  it("creative assignment reordering alone is not a change", () => {
    const previous = snapshot({ entityType: "AD", creativeAssignment: ["cr_1", "cr_2"] });
    const current = snapshot({ entityType: "AD", creativeAssignment: ["cr_2", "cr_1"] });

    expect(diffEntitySnapshots(previous, current, OPTS)).toEqual([]);
  });

  it("multiple simultaneous field changes produce one correctly typed event each", () => {
    const previous = snapshot({
      status: "ACTIVE",
      budget: budget({ dailyBudgetMinorUnits: 50000 }),
    });
    const current = snapshot({
      status: "PAUSED",
      budget: budget({ dailyBudgetMinorUnits: 60000 }),
    });

    const events = diffEntitySnapshots(previous, current, OPTS);

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.field).sort()).toEqual(["BUDGET", "STATUS"]);
  });

  // --- UNKNOWN budget ownership transitions — deliberately never a BUDGET event. See
  // changeEvents.ts's module comment for the full justification. ---

  it("a transition from a real budget INTO UNKNOWN produces no BUDGET event", () => {
    const previous = snapshot({ budget: budget({ dailyBudgetMinorUnits: 50000 }) });
    const current = snapshot({
      budget: {
        ownerLevel: "UNKNOWN",
        dailyBudgetMinorUnits: null,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
    });

    expect(diffEntitySnapshots(previous, current, OPTS)).toEqual([]);
  });

  it("a transition OUT OF UNKNOWN into a real budget produces no BUDGET event", () => {
    const previous = snapshot({
      budget: {
        ownerLevel: "UNKNOWN",
        dailyBudgetMinorUnits: null,
        lifetimeBudgetMinorUnits: null,
        currency: "INR",
      },
    });
    const current = snapshot({ budget: budget({ dailyBudgetMinorUnits: 50000 }) });

    expect(diffEntitySnapshots(previous, current, OPTS)).toEqual([]);
  });

  it("null (not owner) to UNKNOWN, and UNKNOWN to UNKNOWN, produce no BUDGET event", () => {
    const unknown: BudgetOwnership = {
      ownerLevel: "UNKNOWN",
      dailyBudgetMinorUnits: null,
      lifetimeBudgetMinorUnits: null,
      currency: "INR",
    };
    expect(
      diffEntitySnapshots(snapshot({ budget: null }), snapshot({ budget: unknown }), OPTS),
    ).toEqual([]);
    expect(
      diffEntitySnapshots(snapshot({ budget: unknown }), snapshot({ budget: unknown }), OPTS),
    ).toEqual([]);
  });

  it("null (not owner) to a real owning budget IS a BUDGET event, with a null percent (no prior base)", () => {
    const previous = snapshot({ budget: null });
    const current = snapshot({ budget: budget({ dailyBudgetMinorUnits: 50000 }) });

    const events = diffEntitySnapshots(previous, current, OPTS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ field: "BUDGET", before: null, budgetChangePercent: null });
    expect(events[0].after).toEqual(budget({ dailyBudgetMinorUnits: 50000 }));
  });

  it("a real owning budget to null (ownership moved to the other level) IS a BUDGET event", () => {
    const previous = snapshot({ budget: budget({ dailyBudgetMinorUnits: 50000 }) });
    const current = snapshot({ budget: null });

    const events = diffEntitySnapshots(previous, current, OPTS);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ field: "BUDGET", after: null, budgetChangePercent: null });
  });

  it("throws on a mismatched entity pair rather than silently diffing the wrong entity", () => {
    const previous = snapshot({ entityId: "as_1" });
    const current = snapshot({ entityId: "as_2" });

    expect(() => diffEntitySnapshots(previous, current, OPTS)).toThrow(/identity mismatch/);
  });
});
