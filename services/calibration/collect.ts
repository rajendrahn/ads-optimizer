// E3 — Firestore glue. Pure data collection only: full scans of the four collections a
// calibration report reads from, with zero interpretation (no scoring, no bucketing, no
// exclusion decisions) — that all happens in report.ts, over plain in-memory arrays, so it can be
// unit-tested without an emulator. This file's own correctness is proven by
// `collect.emulator.test.ts` instead.
//
// Full collection scans, no query filtering beyond "the whole collection" — matching C1/C2/C3's
// own established "full read pass, filter in memory" precedent at this account's small scale
// (shared/firestore/collections.ts's own comment on why no new composite index was added for E2).
// A calibration report over years of history at real scale would want to page/query narrower —
// flagged here for whoever revisits this once that's a real problem, not solved speculatively now.

import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, createRepository } from "@shared/firestore/index.ts";
import {
  recommendationSchema,
  recommendationOutcomeSchema,
  backtestRunSchema,
  guardrailRejectionLogSchema,
  type Recommendation,
  type RecommendationOutcome,
  type BacktestRun,
  type GuardrailRejectionLog,
} from "@shared/schema/index.ts";

export interface CalibrationRawInputs {
  recommendations: Recommendation[];
  outcomes: RecommendationOutcome[];
  backtestRuns: BacktestRun[];
  guardrailRejections: GuardrailRejectionLog[];
}

/** Reads every document in the four collections a calibration report needs. Read-only — no write
 * of any kind happens anywhere in this module, so it is safe to point at a real (or real-but-empty,
 * as of this step) Firestore project as well as the emulator; the safety constraint this step was
 * built under ("do NOT write to production Firestore") is satisfied structurally, not by
 * convention, since there is no write call in this file at all. */
export async function collectCalibrationInputs(db: Firestore): Promise<CalibrationRawInputs> {
  const recommendationsRepo = createRepository<Recommendation>(
    db,
    COLLECTIONS.recommendations,
    recommendationSchema,
  );
  const outcomesRepo = createRepository<RecommendationOutcome>(
    db,
    COLLECTIONS.recommendationOutcomes,
    recommendationOutcomeSchema,
  );
  const backtestRunsRepo = createRepository<BacktestRun>(
    db,
    COLLECTIONS.backtestRuns,
    backtestRunSchema,
  );
  const guardrailRejectionsRepo = createRepository<GuardrailRejectionLog>(
    db,
    COLLECTIONS.guardrailRejections,
    guardrailRejectionLogSchema,
  );

  const [recommendations, outcomes, backtestRuns, guardrailRejections] = await Promise.all([
    recommendationsRepo.query((ref) => ref),
    outcomesRepo.query((ref) => ref),
    backtestRunsRepo.query((ref) => ref),
    guardrailRejectionsRepo.query((ref) => ref),
  ]);

  return { recommendations, outcomes, backtestRuns, guardrailRejections };
}
