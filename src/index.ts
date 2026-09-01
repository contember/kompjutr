// kompjutr — a SQLite-native filesystem and git backend for Cloudflare Workers.
//
// The filesystem and git database share one Durable Object SQLite database.

export {
  Database,
  type DurableObjectStorageLike,
  type SQLCursorLike,
  type SQLStorageLike,
  type SqlDatabase,
} from "./db/db.js";
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
export type {
  GitCliInput,
  GitCliResult,
  GitCliRunner,
  GitCliRunOptions,
} from "./git/cli/types.js";
export {
  type CreateGitOptions,
  createGit,
  type Git,
  type GitBranchRenameOptions,
  type GitCherryPickContinueOptions,
  type GitCherryPickOptions,
  type GitCloneOptions,
  type GitCommitTreeOptions,
  type GitDivergenceOptions,
  type GitFactory,
  type GitFetchOptions,
  type GitLogOptions,
  type GitLsFilesOptions,
  type GitLsRemoteOptions,
  type GitLsTreeOptions,
  type GitMaintenanceOptions,
  type GitMaintenanceResult,
  type GitMergeBaseOptions,
  type GitMergeContinueOptions,
  type GitMergeOptions,
  type GitPromisorAuth,
  type GitPullOptions,
  type GitPushOptions,
  type GitReadRefOptions,
  type GitReadTreeOptions,
  type GitRebaseContinueOptions,
  type GitRebaseOptions,
  type GitRecoverRefOptions,
  type GitRefLogOptions,
  type GitRemoteGetUrlOptions,
  type GitRemoteSetUrlOptions,
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
  type GitShowOptions,
  type GitShowResult,
  type GitStatusOptions,
  type GitStatusReport,
  type GitStatusReportOptions,
  type GitUpdateRefOptions,
  type GitWorktreeAddOptions,
  type GitWorktreeRemoveOptions,
  type GitWriteTreeOptions,
} from "./git/client.js";
export {
  AlreadyInitializedError,
  CorruptError,
  GitError,
  MissingIdentityError,
  NotARepositoryError,
  ObjectNotFoundError,
  PathOutsideRepoError,
  PathspecNotFoundError,
  PromisedObjectError,
  RefNotFoundError,
  UnsupportedOperationError,
} from "./git/common/errors.js";
export type { GitCliNetworkBinding, GitContext, GitIdentity } from "./git/ops/context.js";
export { findRepository, nestedRoots, openRepository } from "./git/ops/context.js";
export type {
  CommitResult,
  DiffSummaryEntry,
  MergeResult,
  PullResult,
  RebaseResult,
  RemoteView,
  ReplayEmptyReason,
  ReplayResult,
  StatusEntry,
  StatusRow,
} from "./git/ops/kinds.js";
export {
  MAX_LS_REMOTE_PATTERNS,
  MAX_LS_REMOTE_REFS,
} from "./git/ops/ls-remote.js";
export {
  type DivergenceOptions,
  type DivergenceRelationship,
  type DivergenceResult,
  divergence,
  type MergeBaseKind,
  type MergeBaseOptions,
  type MergeBaseResult,
  mergeBase,
} from "./git/ops/merge-base.js";
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
} from "./git/ops/plumbing.js";
export type {
  CommitView,
  LogOptions,
  LsTreeOptions,
  ShowOptions,
  ShowResult,
  TreeEntryView,
} from "./git/ops/reads.js";
export {
  type RecoverRefOptions,
  type RefLogEndpoint,
  type RefLogEntry,
  type RefLogReadOptions,
  type RefLogRecoverySource,
  recoverRef,
  reflog,
} from "./git/ops/ref-log.js";
export {
  type FetchRefspec,
  type FetchRefUpdate,
  type FetchResult,
  type LsRemoteResult,
  MAX_REFSPEC_EXPANDED_DESTINATIONS,
  MAX_REFSPEC_MAPPINGS,
  type PushRefStatus,
  type PushRefspec,
  type PushResult,
  type PushTrackingResult,
  type RemoteRefView,
  type RemoteTarget,
} from "./git/ops/refspec.js";
export {
  type ReplaySnapshotConflict,
  type ReplaySnapshotConflictStage,
  type ReplaySnapshotOptions,
  type ReplaySnapshotResult,
  replaySnapshot,
} from "./git/ops/replay.js";
export { Repository, type RevisionResolution } from "./git/ops/repository.js";
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
} from "./git/ops/status.js";
export {
  type StatusFormatOptions,
  statusFormatOptions,
} from "./git/ops/status-format.js";
export type { Worktree, WorktreeDirent, WorktreeStat } from "./git/ops/worktree.js";
export {
  type WorktreeAddOptions,
  type WorktreeAddTarget,
  type WorktreeInfo,
  type WorktreeRemoveOptions,
  worktreeAdd,
  worktreeList,
  worktreePrune,
  worktreeRemove,
} from "./git/ops/worktrees.js";
export {
  type CheckoutRow,
  CheckoutStore,
  type IndexEntry,
  type IndexStore,
  SharedRepoStore,
  SqliteGitDatabase,
  type StoreOptions,
} from "./git/store/index.js";
export { initializeGitSchema, SCHEMA_VERSION } from "./git/store/schema.js";
export {
  type Async,
  type AsyncFilesystem,
  type ExitStatus,
  type ProcessEvent,
  type ProcessExecOptions,
  type ProcessHandle,
  type ProcessHost,
  type ProcessResult,
  type RpcHost,
  Workspace,
  type WorkspaceOptions,
} from "./runtime/index.js";
