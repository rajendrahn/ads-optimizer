// Barrel for services/analytics. C1 (daily normalization), C2 (feature engine) and C5
// (calendar/seasonality) are here — see each subdirectory's own index.ts. C3/C4 add their own
// subdirectories alongside these.
//
// C2's `./features/index.ts` is deliberately NOT re-exported here (unlike daily/seasonality) —
// it defines its own `DayRange`/`SeasonalityContext` types (its own copy of C5's contract, per
// this step's brief: "code against exactly this... do not invent your own shape" — same names,
// independently defined, not imported from C5) which collide with `./seasonality/index.ts`'s
// own exports of the same names under a wildcard re-export (`export *` treats that as an error
// under this project's module settings, not a silent drop). Nothing needs the combined barrel —
// every caller imports `@services/analytics/features/index.ts` directly.

export * from "./daily/index.ts";
export * from "./seasonality/index.ts";
// C4's change-aware and learning-phase features (§13, §13.1) — its own enrichment pass over
// C2's already-written feature docs, not a restructuring of ./features/entityFeaturesBuilder.ts.
// No name collisions with ./features's own barrel (which is not re-exported here — see this
// file's own comment above), so this one is safe to add.
export * from "./changeFeatures/index.ts";
// C3's statistics layer (§15) — intervals, three-state verdicts and account-mean shrinkage, its
// own enrichment pass over C2's already-written feature docs (same pattern as C4's above). No
// name collisions with ./features's own barrel (not re-exported here — see this file's comment
// above) or with ./changeFeatures.
export * from "./statistics/index.ts";
