// Barrel for services/analytics. C1 (daily normalization) is the first thing here — see
// daily/index.ts. Later steps (C2 features, C3 statistics, C4 change-aware/learning-phase, C5
// calendar/seasonality) add their own subdirectories alongside this one.

export * from "./daily/index.ts";
