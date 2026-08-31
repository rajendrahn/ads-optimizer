// Barrel for C4's change-aware and learning-phase features (§13, §13.1).

export { computeChangeAwareFeatures, type ChangeAwareInput } from "./changeAwareFeatures.ts";
export {
  computeLearningPhaseFeatures,
  type LearningPhaseInput,
  type BudgetChangeCandidate,
} from "./learningPhase.ts";
export {
  LEARNING_PHASE_CONVERSION_THRESHOLD,
  LEARNING_PHASE_WINDOW_DAYS,
  MATERIAL_BUDGET_CHANGE_THRESHOLD_PERCENT,
  RECENT_CHANGE_WINDOW_DAYS,
} from "./constants.ts";
export {
  enrichChangeFeaturesHandler,
  enrichChangeFeaturesRegistration,
  type EnrichChangeFeaturesPayload,
} from "./enrichChangeFeaturesTask.ts";
