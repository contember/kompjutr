// Compatibility facade for the SQLite repository store.

export { CheckoutStore } from "./checkout/checkout.js";
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
} from "./core/contracts.js";
export { FetchPublicationToken, TrackingRefPublicationToken } from "./core/contracts.js";
export {
  listCheckoutsOwned,
  SqliteGitDatabase,
} from "./database/database.js";
export {
  ancestors,
  normalizeRoot,
  PROVISIONAL_CLONE_LEASE_MS,
  PROVISIONAL_CLONE_RENEW_WINDOW_MS,
} from "./database/lifecycle.js";
export { indexScanOwned } from "./indexes/index-table.js";
export { contentIdKey } from "./objects/blob-ids.js";
export { readAuthenticatedObjectOwned } from "./objects/objects.js";
export {
  type OperationRootPage,
  type RebaseJournalCursor,
  readOperationStateOwned,
  readRebaseCursorOwned,
} from "./operations/operation-journal.js";
export { PACK_BLOB_BATCH_TARGET_BYTES } from "./pack/packs.js";
export {
  CONFIG_SECTION_MOVE_UPDATE_SQL,
  configGetOwned,
  MAX_CONFIG_SECTION_MOVE_ROWS,
} from "./refs/config.js";
export { MAX_REFLOG_ROOT_SCAN_ENTRIES } from "./refs/reflog.js";
export { readShallowOwned } from "./refs/shallow.js";
export { SharedRepoStore } from "./repository/shared.js";
export { MAX_LOG_COMMITS } from "./trees/commits.js";
export type { WalkTreeDiffEntry, WalkTreeDiffObject, WalkTreeEntry } from "./trees/tree-walk.js";
export { WALK_TREE_SQL } from "./trees/tree-walk.js";
