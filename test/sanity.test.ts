// A1 deliverable: proves the Vitest harness (config, TS transform, .ts-extension ESM
// imports) actually works end to end. Real tests land alongside the code they cover
// starting at A2.

import { describe, expect, it } from "vitest";
import { GCP_PROJECT_ID } from "../scripts/config.ts";

describe("test harness", () => {
  it("runs a trivial assertion", () => {
    expect(1 + 1).toBe(2);
  });

  it("can import a .ts module the way scripts/services will", () => {
    expect(GCP_PROJECT_ID).toBe("sng-meta-ads-optimizer");
  });
});
