export {
  type CreateSqliteGitClientOptions,
  createSqliteGitClient,
} from "../computer/client.js";
export { ComputerWorktree } from "../computer/worktree.js";
export type {
  CompatWriteFilesEntry,
  CompatWriteFilesOptions,
  NodeDirent,
  NodeStats,
  ReadFilesEntry,
  WalkEntry,
  WalkOptions,
} from "../fs/compat/computer.js";
export {
  NodeFsCompat,
  shellQuote,
  withReadScope,
} from "../fs/compat/computer.js";
export {
  assertComputerImportCurrent,
  COMPUTER_IMPORT_ACKNOWLEDGEMENT,
  type ComputerImportResult,
  type ImportFromComputerOptions,
  importFromComputer,
} from "../fs/import.js";
