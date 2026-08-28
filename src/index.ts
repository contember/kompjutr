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
  RebaseResult,
  RefUpdateStatus,
  RemoteView,
  ReplayEmptyReason,
  ReplayResult,
  StatusEntry,
  StatusRow,
} from "./core/ops/kinds.js";
export {
  type DivergenceOptions,
  type DivergenceRelationship,
  type DivergenceResult,
  divergence,
  type MergeBaseKind,
  type MergeBaseOptions,
  type MergeBaseResult,
  mergeBase,
} from "./core/ops/merge-base.js";
export {
  type CommitTreeOptions,
  commitTree,
  type RawRefTarget,
  type ReadRefOptions,
  type ReadTreeOptions,
  readRef,
  readTree,
  type UpdateRefDeleteOptions,
  type UpdateRefGuardedOptions,
  type UpdateRefOptions,
  type UpdateRefWriteOptions,
  updateRef,
  writeTree,
} from "./core/ops/plumbing.js";
export type { CommitView, LsTreeOptions, TreeEntryView } from "./core/ops/reads.js";
export {
  type RecoverRefOptions,
  type RefLogEndpoint,
  type RefLogEntry,
  type RefLogReadOptions,
  type RefLogRecoverySource,
  recoverRef,
  reflog,
} from "./core/ops/ref-log.js";
export {
  type FetchRefspec,
  type FetchRefUpdate,
  type FetchResult,
  type LsRemoteResult,
  MAX_REFSPEC_EXPANDED_DESTINATIONS,
  MAX_REFSPEC_MAPPINGS,
  MAX_REFSPEC_REF_BYTES,
  type PushRefStatus,
  type PushRefspec,
  type PushResult,
  type PushTrackingResult,
  type RemoteRefView,
  type RemoteTarget,
} from "./core/ops/refspec.js";
export {
  type ReplaySnapshotConflict,
  type ReplaySnapshotConflictStage,
  type ReplaySnapshotOptions,
  type ReplaySnapshotResult,
  replaySnapshot,
} from "./core/ops/replay.js";
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
export {
  type StatusFormatOptions,
  statusFormatOptions,
} from "./core/ops/status-format.js";
export {
  type WorktreeAddOptions,
  type WorktreeAddTarget,
  type WorktreeInfo,
  type WorktreeRemoveOptions,
  worktreeAdd,
  worktreeList,
  worktreePrune,
  worktreeRemove,
} from "./core/ops/worktrees.js";
export { Repository, type RevisionResolution } from "./core/repository.js";
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
  type GitCommitTreeOptions,
  type GitDivergenceOptions,
  type GitFactory,
  type GitLsTreeOptions,
  type GitMaintenanceOptions,
  type GitMaintenanceResult,
  type GitMergeBaseOptions,
  type GitMergeContinueOptions,
  type GitMergeOptions,
  type GitPullOptions,
  type GitReadRefOptions,
  type GitReadTreeOptions,
  type GitRebaseContinueOptions,
  type GitRebaseOptions,
  type GitRecoverRefOptions,
  type GitRefLogOptions,
  type GitRevertContinueOptions,
  type GitRevertOptions,
  type GitRevParseOptions,
  type GitScratchAddOptions,
  type GitScratchCommitTreeOptions,
  type GitScratchIndex,
  type GitScratchIndexCallback,
  type GitScratchIndexOptions,
  type GitScratchReadTreeOptions,
  type GitScratchReplaySnapshotOptions,
  type GitStatusOptions,
  type GitStatusReport,
  type GitStatusReportOptions,
  type GitUpdateRefOptions,
  type GitWorktreeAddOptions,
  type GitWorktreeRemoveOptions,
  type GitWriteTreeOptions,
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
  type CheckoutRow,
  CheckoutStore,
  type IndexEntry,
  type IndexStore,
  SharedRepoStore,
  SqliteGitDatabase,
  type StoreOptions,
} from "./sqlite/store.js";
