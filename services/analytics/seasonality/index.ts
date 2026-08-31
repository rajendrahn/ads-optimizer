// Barrel for C5's calendar and seasonality context (IMPLEMENTATION_PLAN.md C5).

export { seasonalityContextFor, type SeasonalityContext } from "./context.ts";
export {
  calendarFeaturesForDay,
  calendarFeaturesForWindow,
  type CalendarDayFeatures,
  type CalendarWindowFeatures,
} from "./dayFeatures.ts";
export {
  labelsForRange,
  isOffSeasonDay,
  sameRegime,
  rangesOverlap,
  type DayRange,
} from "./labels.ts";
export {
  computeDemandIndex,
  DEFAULT_DEMAND_INDEX_OPTIONS,
  MIN_SAMPLE_SIZE_FOR_INDEX,
  type ComputeDemandIndexInput,
  type DemandIndexOptions,
  type DemandIndexResult,
  type OccurrenceDetail,
} from "./demandIndex.ts";
export { loadSeasonalCalendarWindows } from "./calendarRepo.ts";
export { loadDemandSourceMaps, type DemandSourceMaps } from "./shopifyDemandSource.ts";
export { SEASONAL_CALENDAR_SEED_ENTRIES, type SeasonalCalendarSeedEntry } from "./calendarSeed.ts";
export {
  seedSeasonalCalendarHandler,
  seedSeasonalCalendarRegistration,
  SEASONAL_CALENDAR_SEED_SOURCE_UPDATED_AT,
} from "./seedTask.ts";
