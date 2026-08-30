// settings/{accountId} — §8, §5.
//
// Ambiguity surfaced: A3's own spec ("Depends on: A2", Design refs §5/§19.2) claims
// "settings/ document schema and a cached, validated loader" as ITS deliverable — the same
// collection A2's spec says to type "for every collection in §8". Resolved pragmatically:
// A2 defines only the reporting-canon fields §5 already gives verbatim (the four-field JSON
// example in §5 is unambiguous and doesn't need A3's judgment to type), fixes the
// collection's key convention, and stops there. A3 owns the loader, the "throw on
// absence/invalid rather than default" behaviour §5's notes-for-the-planning-agent require,
// and any extension (model config per §19.2, statistical thresholds per §15.1) — extend
// this schema with `.extend(...)` rather than replacing it, so A2's key convention and
// these four fields stay stable for whatever already reads them.

import { z } from "zod";

export const reportingCanonSettingsSchema = z.object({
  accountId: z.string().min(1), // also the doc ID — see shared/firestore/collections.ts
  reportingTimezone: z.string().min(1), // IANA name, e.g. "Asia/Kolkata" (§5.1)
  reportingCurrency: z.string().length(3), // ISO 4217 (§5.2)
  attributionWindow: z.string().min(1), // e.g. "7d_click_1d_view" (§5.3)
  purchaseActionType: z.string().min(1), // e.g. "offsite_conversion.fb_pixel_purchase" (§5.3)
});
export type ReportingCanonSettings = z.infer<typeof reportingCanonSettingsSchema>;
