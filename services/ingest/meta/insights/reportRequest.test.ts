import { describe, expect, it } from "vitest";
import {
  buildInsightsPageParams,
  buildSubmitParams,
  decideReportStatus,
  extractReportRunId,
  findActionValue,
} from "./reportRequest.ts";

describe("buildSubmitParams", () => {
  it("builds the async report submission body with the pinned attribution window", () => {
    const params = buildSubmitParams({
      since: "2026-08-01",
      until: "2026-08-30",
      attributionWindow: "7d_click_1d_view",
    });
    expect(params.level).toBe("ad");
    expect(params.time_increment).toBe("1");
    expect(JSON.parse(params.time_range as string)).toEqual({
      since: "2026-08-01",
      until: "2026-08-30",
    });
    expect(JSON.parse(params.action_attribution_windows as string)).toEqual([
      "7d_click",
      "1d_view",
    ]);
    expect(params.fields).toContain("ad_id");
    expect(params.fields).toContain("actions");
  });

  it("propagates an invalid attribution window as a thrown error, not a silent empty array", () => {
    expect(() =>
      buildSubmitParams({ since: "2026-08-01", until: "2026-08-30", attributionWindow: "" }),
    ).toThrow(/does not contain/);
  });
});

describe("extractReportRunId", () => {
  it("returns report_run_id when present", () => {
    expect(extractReportRunId({ report_run_id: "rr_1" })).toBe("rr_1");
  });

  it("throws when Meta's response has no report_run_id", () => {
    expect(() => extractReportRunId({})).toThrow(/no report_run_id/);
  });
});

describe("decideReportStatus", () => {
  it("maps 'Job Completed' to ready", () => {
    expect(decideReportStatus({ async_status: "Job Completed" })).toBe("ready");
  });

  it("maps in-progress statuses to pending", () => {
    expect(decideReportStatus({ async_status: "Job Not Started" })).toBe("pending");
    expect(decideReportStatus({ async_status: "Job Started" })).toBe("pending");
    expect(decideReportStatus({ async_status: "Job Running" })).toBe("pending");
  });

  it("maps 'Job Failed' and 'Job Skipped' to failed", () => {
    expect(decideReportStatus({ async_status: "Job Failed" })).toBe("failed");
    expect(decideReportStatus({ async_status: "Job Skipped" })).toBe("failed");
  });

  it("treats an unrecognized status as pending, not failed", () => {
    expect(decideReportStatus({ async_status: "Something New" })).toBe("pending");
    expect(decideReportStatus({})).toBe("pending");
  });
});

describe("buildInsightsPageParams", () => {
  it("omits `after` on the first page", () => {
    expect(buildInsightsPageParams(null)).toEqual({ limit: "500" });
  });

  it("includes `after` when resuming from a cursor", () => {
    expect(buildInsightsPageParams("cursor123", 250)).toEqual({
      limit: "250",
      after: "cursor123",
    });
  });
});

describe("findActionValue", () => {
  it("finds the value for a matching action_type", () => {
    expect(findActionValue([{ action_type: "add_to_cart", value: "3" }], "add_to_cart")).toBe("3");
  });

  it("returns '0' when the action type is absent (a genuine zero, not an error)", () => {
    expect(findActionValue([{ action_type: "add_to_cart", value: "3" }], "purchase")).toBe("0");
    expect(findActionValue(undefined, "purchase")).toBe("0");
  });
});
