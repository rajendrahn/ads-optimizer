// Barrel for B5's Shopify orders/lines/refunds ingestion — Matrixify CSV backfill +
// incremental GraphQL sync.

export {
  isJunkMatrixifyRow,
  parseMatrixifyCsv,
  type MatrixifyOrderGroup,
  type MatrixifyRow,
  type ParseMatrixifyCsvResult,
} from "./csvParser.ts";
export {
  normalizeMatrixifyOrderGroup,
  type NormalizeMatrixifyOrderCtx,
  type NormalizeMatrixifyOrderResult,
} from "./csvNormalize.ts";
export { parseMatrixifyTimestamp, parseOptionalMatrixifyTimestamp } from "./timestamps.ts";
export {
  createDefaultMatrixifyCsvSource,
  GcsMatrixifyCsvSource,
  SHOPIFY_MATRIXIFY_DEFAULT_OBJECT_KEY,
  type CsvStorageBucketLike,
  type CsvStorageFileLike,
  type MatrixifyCsvSource,
} from "./csvSource.ts";
export {
  createMatrixifyImportHandler,
  matrixifyImportHandler,
  matrixifyImportRegistration,
  type MatrixifyImportPayload,
} from "./matrixifyImport.ts";
export {
  numericIdFromGid,
  normalizeGraphqlOrder,
  type NormalizeGraphqlOrderCtx,
  type NormalizeGraphqlOrderResult,
  type RawGraphqlLineItem,
  type RawGraphqlOrderNode,
  type RawGraphqlRefund,
} from "./graphqlNormalize.ts";
export {
  fetchAllUpdatedOrders,
  fetchUpdatedOrdersPage,
  SYNC_ORDERS_QUERY,
  type FetchUpdatedOrdersPageOptions,
  type FetchUpdatedOrdersPageResult,
} from "./graphqlFetch.ts";
export {
  shopifySyncOrdersHandler,
  shopifySyncOrdersRegistration,
  type ShopifySyncOrdersPayload,
} from "./ordersSync.ts";
export {
  computeShopifyOrdersGap,
  SHOPIFY_READ_ORDERS_WINDOW_DAYS,
  type ComputeShopifyOrdersGapInput,
} from "./gap.ts";
export {
  computeNewVsRepeat,
  recomputeAndPersistNewVsRepeat,
  type CustomerOrderRef,
  type RecomputeNewVsRepeatResult,
} from "./newVsRepeat.ts";
