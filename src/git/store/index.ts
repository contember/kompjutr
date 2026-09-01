// Compatibility facade for the SQLite repository store.

export { contentIdKey } from "./blob-ids.js";
export { CheckoutStore } from "./checkout.js";
export { MAX_LOG_COMMITS } from "./commits.js";
export {
  CONFIG_SECTION_MOVE_UPDATE_SQL,
  configGetOwned,
  MAX_CONFIG_SECTION_MOVE_ROWS,
} from "./config.js";
export type {
  BlobIdMapping,
  BlobReadBatch,
  BoundedSingleConfigValue,
  CheckoutRow,
  FetchPublicationExpectedRef,
  FetchPublicationPlan,
  IndexApplyOptions,
  IndexEntry,
  IndexScanOptions,
  IndexSink,
  IndexStore,
  InitialStateResult,
  InitialStateSession,
  ObjectBatch,
  ObjectBatchOptions,
  ObjectReadBatch,
  ObjectReadInfo,
  OwnedObjectBatch,
  PromisedBlob,
  PromisorRemote,
  ProvisionalCloneOwner,
  RefLogActor,
  RefLogEntry,
  RefLogMetadata,
  RefLogReadOptions,
  RefMutation,
  RefRow,
  RepositoryLifecycle,
  StoreOptions,
} from "./contracts.js";
export { FetchPublicationToken, TrackingRefPublicationToken } from "./contracts.js";
export {
  advanceMaintenanceRootSnapshotOwned,
  listCheckoutsOwned,
  SqliteGitDatabase,
} from "./database.js";
export { indexScanOwned } from "./index-table.js";
export {
  ancestors,
  normalizeRoot,
  PROVISIONAL_CLONE_LEASE_MS,
  PROVISIONAL_CLONE_RENEW_WINDOW_MS,
} from "./lifecycle.js";
export {
  readAuthenticatedObjectOwned,
  writeBatchOwned,
  writeObjectsOwned,
} from "./objects.js";
export {
  readOperationStateOwned,
  replaceOperationJournalOwned,
  replaceOperationStateOwned,
  writeOperationJournalOwned,
} from "./operation-journal.js";
export { PACK_BLOB_BATCH_TARGET_BYTES } from "./packs.js";
export { MAX_REFLOG_ROOT_SCAN_ENTRIES } from "./reflog.js";
export { mutateRefsOwned } from "./refs.js";
export { readShallowOwned } from "./shallow.js";
export { SharedRepoStore } from "./shared.js";
export type { WalkTreeDiffEntry, WalkTreeDiffObject, WalkTreeEntry } from "./tree-walk.js";
export { WALK_TREE_SQL } from "./tree-walk.js";
