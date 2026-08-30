import { describe, expect, it } from "vitest";
import { parseMatrixifyTimestamp, parseOptionalMatrixifyTimestamp } from "./timestamps.ts";

describe("parseMatrixifyTimestamp", () => {
  it("parses the exact format from the real export (+0530)", () => {
    expect(parseMatrixifyTimestamp("2025-01-15 14:27:06 +0530").toISOString()).toBe(
      "2025-01-15T08:57:06.000Z",
    );
  });

  it("parses a negative offset correctly (does not assume IST)", () => {
    expect(parseMatrixifyTimestamp("2025-07-01 00:00:00 -0500").toISOString()).toBe(
      "2025-07-01T05:00:00.000Z",
    );
  });

  it("parses a zero offset (UTC)", () => {
    expect(parseMatrixifyTimestamp("2025-01-15 14:27:06 +0000").toISOString()).toBe(
      "2025-01-15T14:27:06.000Z",
    );
  });

  it("parses an offset with a non-zero minute component", () => {
    // India Standard Time is +05:30, not a whole-hour offset — this is the case that breaks a
    // parser that only handles +HH:00 offsets.
    expect(parseMatrixifyTimestamp("2025-12-13 06:31:48 +0530").toISOString()).toBe(
      "2025-12-13T01:01:48.000Z",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseMatrixifyTimestamp("  2025-01-15 14:27:06 +0530  ").toISOString()).toBe(
      "2025-01-15T08:57:06.000Z",
    );
  });

  it("throws on a malformed string", () => {
    expect(() => parseMatrixifyTimestamp("2025-01-15T14:27:06Z")).toThrow(/does not match/);
  });

  it("throws on an empty string", () => {
    expect(() => parseMatrixifyTimestamp("")).toThrow(/does not match/);
  });
});

describe("parseOptionalMatrixifyTimestamp", () => {
  it("returns null for an empty string", () => {
    expect(parseOptionalMatrixifyTimestamp("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(parseOptionalMatrixifyTimestamp("   ")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(parseOptionalMatrixifyTimestamp(null)).toBeNull();
    expect(parseOptionalMatrixifyTimestamp(undefined)).toBeNull();
  });

  it("parses a real value", () => {
    expect(parseOptionalMatrixifyTimestamp("2025-01-15 14:48:50 +0530")?.toISOString()).toBe(
      "2025-01-15T09:18:50.000Z",
    );
  });
});
