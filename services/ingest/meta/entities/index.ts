// Barrel for B2's Meta entity sync + config snapshot tasks.

export {
  determineAdsetBudget,
  determineCampaignBudget,
  determineCampaignBudgetGivenChildren,
  type DetermineAdsetBudgetInput,
  type RawMetaBudgetFields,
} from "./budgetOwnership.ts";
export {
  normalizeAd,
  normalizeAdset,
  normalizeCampaign,
  normalizeCreative,
  type NormalizeAccountCtx,
  type NormalizeAdCtx,
  type RawMetaAd,
  type RawMetaAdset,
  type RawMetaCampaign,
  type RawMetaCreative,
} from "./normalize.ts";
export {
  fetchAccountCurrency,
  fetchAllAds,
  fetchAllAdsets,
  fetchAllCampaigns,
  fetchAllCreatives,
  type PaginatedFetchResult,
} from "./fetch.ts";
export { fetchAllMetaEntities, type FetchedMetaEntities } from "./fetchAll.ts";
export { metaSyncEntitiesHandler, metaSyncEntitiesRegistration } from "./entitySync.ts";
export { metaSnapshotConfigHandler, metaSnapshotConfigRegistration } from "./configSnapshot.ts";
export {
  diffEntitySnapshots,
  deriveAndWriteChangeEvents,
  type DiffSnapshotPairOptions,
  type DeriveAndWriteChangeEventsOptions,
  type DeriveAndWriteChangeEventsResult,
} from "./changeEvents.ts";
