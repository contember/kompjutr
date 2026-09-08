export {
  type BufferedIndexMutation,
  DEFAULT_INDEX_FLUSH,
  IndexMutationBuffer,
  indexScanOwned,
  type OwnedIndexSource,
  requireStoredIndexEntry,
  scanGenericIndexOwned,
  scanIndexOwned,
  validateInitialIndexEntry,
} from "./index-table-helpers.js";
export { IndexTable, ScratchIndexStore } from "./index-table-store.js";
