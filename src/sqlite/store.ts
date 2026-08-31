// Compatibility facade for the SQLite repository store.
export { PACK_BLOB_BATCH_TARGET_BYTES } from "./packs.js";
export {
  ancestors,
  CheckoutStore,
  CONFIG_SECTION_MOVE_UPDATE_SQL,
  configGetOwned,
  contentIdKey,
  indexScanOwned,
  MAX_CONFIG_SECTION_MOVE_ROWS,
  MAX_REFLOG_ROOT_SCAN_ENTRIES,
  mutateRefsOwned,
  normalizeRoot,
  PROVISIONAL_CLONE_LEASE_MS,
  readAuthenticatedObjectOwned,
  readOperationStateOwned,
  readShallowOwned,
  replaceOperationJournalOwned,
  replaceOperationStateOwned,
  writeBatchOwned,
  writeObjectsOwned,
  writeOperationJournalOwned,
} from "./store/checkout.js";
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
  ProvisionalCloneOwner,
  RefLogActor,
  RefLogEntry,
  RefLogMetadata,
  RefLogReadOptions,
  RefMutation,
  RefRow,
  RepositoryLifecycle,
  StoreOptions,
} from "./store/contracts.js";
export { FetchPublicationToken, TrackingRefPublicationToken } from "./store/contracts.js";
export {
  advanceMaintenanceRootSnapshotOwned,
  listCheckoutsOwned,
  SqliteGitDatabase,
} from "./store/database.js";
export { SharedRepoStore } from "./store/shared.js";
export type { WalkTreeDiffEntry, WalkTreeDiffObject, WalkTreeEntry } from "./tree-walk.js";
export { WALK_TREE_SQL } from "./tree-walk.js";
