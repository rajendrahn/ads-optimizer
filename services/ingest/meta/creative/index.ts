// Barrel for B8's creative identity grouping (§7.3, §11.1).

export {
  buildCreativeIdentity,
  clusterAssetsByPerceptualHash,
  compositeFamilyId,
  type BuildCreativeIdentityOptions,
  type BuildCreativeIdentityResult,
} from "./identity.ts";
export {
  metaSyncCreativeIdentityHandler,
  metaSyncCreativeIdentityRegistration,
} from "./creativeIdentitySync.ts";
