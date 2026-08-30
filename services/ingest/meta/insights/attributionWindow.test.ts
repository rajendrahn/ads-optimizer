import { describe, expect, it } from "vitest";
import { parseAttributionWindowTokens } from "./attributionWindow.ts";

describe("parseAttributionWindowTokens", () => {
  it("parses the account's real combined window (confirmed live in B2)", () => {
    expect(parseAttributionWindowTokens("7d_click_1d_view")).toEqual(["7d_click", "1d_view"]);
  });

  it("parses a single-window value", () => {
    expect(parseAttributionWindowTokens("28d_click")).toEqual(["28d_click"]);
    expect(parseAttributionWindowTokens("1d_view")).toEqual(["1d_view"]);
  });

  it("parses every documented Meta window length", () => {
    expect(
      parseAttributionWindowTokens("1d_click_7d_click_28d_click_1d_view_7d_view_28d_view"),
    ).toEqual(["1d_click", "7d_click", "28d_click", "1d_view", "7d_view", "28d_view"]);
  });

  it("throws on a string with no recognizable token rather than silently sending an empty array", () => {
    expect(() => parseAttributionWindowTokens("default")).toThrow(/does not contain/);
    expect(() => parseAttributionWindowTokens("")).toThrow(/does not contain/);
  });
});
