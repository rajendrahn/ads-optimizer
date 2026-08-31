import { describe, expect, it } from "vitest";
import {
  NULL_SEASONALITY_CONTEXT,
  resolveSeasonalityContext,
  toSeasonalityContextSnapshot,
} from "./seasonality.ts";

describe("resolveSeasonalityContext", () => {
  it("returns the null-ish context when no provider is injected — C5 not wired in", async () => {
    const result = await resolveSeasonalityContext(undefined, {
      startDay: "2026-08-24",
      endDay: "2026-08-30",
    });
    expect(result).toEqual(NULL_SEASONALITY_CONTEXT);
  });

  it("calls the injected provider with the window and baseline, and returns its result", async () => {
    let received: unknown;
    const provider = async (window: unknown, baseline: unknown) => {
      received = { window, baseline };
      return {
        labels: ["diwali"],
        spansSeasonalBoundary: true,
        demandIndex: 1.8,
        demandIndexSampleSize: 1,
        summaryText: "This window covers Diwali; its baseline does not.",
      };
    };
    const window = { startDay: "2025-10-15", endDay: "2025-10-21" } as const;
    const baseline = { startDay: "2025-09-15", endDay: "2025-09-21" } as const;
    const result = await resolveSeasonalityContext(provider, window, baseline);
    expect(result.labels).toEqual(["diwali"]);
    expect(result.spansSeasonalBoundary).toBe(true);
    expect(received).toEqual({ window, baseline });
  });

  it("tolerates a provider that throws — falls back to the null context rather than failing the recompute", async () => {
    const provider = async () => {
      throw new Error("transient Firestore read failure");
    };
    const result = await resolveSeasonalityContext(provider, {
      startDay: "2026-08-24",
      endDay: "2026-08-30",
    });
    expect(result).toEqual(NULL_SEASONALITY_CONTEXT);
  });
});

describe("toSeasonalityContextSnapshot", () => {
  it("maps every field 1:1, no adjustment of any kind", () => {
    const context = {
      labels: ["navratri"],
      spansSeasonalBoundary: false,
      demandIndex: 1.2,
      demandIndexSampleSize: 1,
      summaryText: "Navratri.",
    };
    expect(toSeasonalityContextSnapshot(context)).toEqual(context);
  });
});
