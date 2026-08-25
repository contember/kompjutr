// kompjutr — a SQLite-native filesystem and git backend for Cloudflare Workers.
//
// The filesystem and git database share one Durable Object SQLite database.
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
  RebaseResult,
  RefUpdateStatus,
  RemoteView,
  ReplayEmptyReason,
  ReplayResult,
  StatusEntry,
  StatusRow,
} from "./core/ops/kinds.js";
export type { CommitView, TreeEntryView } from "./core/ops/reads.js";
export {
  formatPorcelainV1,
  formatPorcelainV2,
  formatShort,
  type StatusBranch,
  type StatusDetail,
  type StatusOptions,
  type StatusReport,
  type StatusReportOptions,
  status,
  statusReport,
  statusStream,
} from "./core/ops/status.js";
export { Repository } from "./core/repository.js";
export type { Worktree, WorktreeDirent, WorktreeStat } from "./core/worktree.js";
export { NodeFsCompat } from "./fs/compat/node.js";
export { createFilesystem } from "./fs/filesystem.js";
export { FS_SCHEMA_VERSION, initializeFsSchema } from "./fs/schema.js";
export type {
  Dirent,
  DiscoverFilesOptions,
  DiscoverFilesPage,
  EntryType,
  Filesystem,
  FilesystemOptions,
  HandleReadBatch,
  ReadBatch,
  RealPath,
  RegularFileHandle,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  Stat,
  WriteEntry,
  WriteOptions,
} from "./fs/types.js";
export {
  type CreateGitOptions,
  createGit,
  type Git,
  type GitCherryPickContinueOptions,
  type GitCherryPickOptions,
  type GitFactory,
  type GitMergeContinueOptions,
  type GitMergeOptions,
  type GitPullOptions,
  type GitRebaseContinueOptions,
  type GitRebaseOptions,
  type GitRevertContinueOptions,
  type GitRevertOptions,
  type GitStatusOptions,
  type GitStatusReport,
  type GitStatusReportOptions,
} from "./git/client.js";
export {
  type Async,
  type AsyncFilesystem,
  type ExitStatus,
  type GitCliInput,
  type GitCliResult,
  type ProcessEvent,
  type ProcessExecOptions,
  type ProcessHandle,
  type ProcessHost,
  type ProcessResult,
  type RpcHost,
  Workspace,
  type WorkspaceOptions,
} from "./runtime/index.js";
export {
  Database,
  type DurableObjectStorageLike,
  type SQLCursorLike,
  type SQLStorageLike,
  type SqlDatabase,
} from "./sqlite/db.js";
export { initializeGitSchema, SCHEMA_VERSION } from "./sqlite/schema.js";
export {
  type IndexEntry,
  RepoStore,
  type RepositoryRow,
  SqliteGitDatabase,
  type StoreOptions,
} from "./sqlite/store.js";
