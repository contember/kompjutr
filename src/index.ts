// kompjutr — a SQLite-native filesystem and git backend for Cloudflare Workers.
//
// The filesystem and git database share one Durable Object SQLite database.
// The Computer exports below remain only for the compatibility milestone.

export {
  type CreateSqliteGitClientOptions,
  createSqliteGitClient,
} from "./computer/client.js";
export { ComputerWorktree } from "./computer/worktree.js";
export type { GitContext, GitIdentity } from "./core/context.js";
export { findRepository, nestedRoots, openRepository } from "./core/context.js";
export {
  AlreadyInitializedError,
  CorruptError,
  GitError,
  MissingIdentityError,
  NotARepositoryError,
  ObjectNotFoundError,
  PathOutsideRepoError,
  PathspecNotFoundError,
  RefNotFoundError,
  UnsupportedOperationError,
} from "./core/errors.js";
export type {
  CommitResult,
  DiffSummaryEntry,
  MergeResult,
  PushResult,
  RefUpdateStatus,
  RemoteView,
  StatusEntry,
  StatusRow,
} from "./core/ops/kinds.js";
export type { CommitView, TreeEntryView } from "./core/ops/reads.js";
export {
  formatPorcelainV1,
  formatPorcelainV2,
  formatShort,
  type StatusDetail,
  status,
  statusStream,
} from "./core/ops/status.js";
export { Repository } from "./core/repository.js";
export type { Worktree, WorktreeDirent, WorktreeStat } from "./core/worktree.js";
export { NodeFsCompat } from "./fs/compat/node.js";
export { createFilesystem } from "./fs/filesystem.js";
export { FS_SCHEMA_VERSION, initializeFsSchema } from "./fs/schema.js";
export type {
  Dirent,
  EntryType,
  Filesystem,
  FilesystemOptions,
  ReadBatch,
  RealPath,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  Stat,
  WriteEntry,
  WriteOptions,
} from "./fs/types.js";
export type { SqlDatabase } from "./sqlite/db.js";
export { initializeGitSchema, SCHEMA_VERSION } from "./sqlite/schema.js";
export {
  type IndexEntry,
  RepoStore,
  type RepositoryRow,
  SqliteGitDatabase,
  type StoreOptions,
} from "./sqlite/store.js";
