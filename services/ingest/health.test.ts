import { describe, expect, it } from "vitest";
import { classifySyncStatus } from "./health.ts";

describe("classifySyncStatus", () => {
  it("is unauthorized whenever the credential is not authorized, regardless of row count", () => {
    expect(classifySyncStatus({ authorized: false })).toBe("unauthorized");
    expect(classifySyncStatus({ authorized: false, newRowCount: 0 })).toBe("unauthorized");
    expect(classifySyncStatus({ authorized: false, newRowCount: 42 })).toBe("unauthorized");
  });

  it("is no_new_data only when authorized and exactly zero rows came back", () => {
    expect(classifySyncStatus({ authorized: true, newRowCount: 0 })).toBe("no_new_data");
  });

  it("is healthy when authorized and at least one row came back", () => {
    expect(classifySyncStatus({ authorized: true, newRowCount: 1 })).toBe("healthy");
    expect(classifySyncStatus({ authorized: true, newRowCount: 500 })).toBe("healthy");
  });

  it("defaults to healthy when authorized and row count is not yet known", () => {
    expect(classifySyncStatus({ authorized: true })).toBe("healthy");
  });
});
