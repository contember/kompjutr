export type { GitContext, GitIdentity } from "../core/context.js";
export { findRepository, nestedRoots, openRepository } from "../core/context.js";
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
} from "../core/errors.js";
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
} from "../core/ops/kinds.js";
export type { CommitView, TreeEntryView } from "../core/ops/reads.js";
export {
  formatPorcelainV1,
  formatPorcelainV2,
  formatShort,
  type StatusDetail,
  status,
  statusStream,
} from "../core/ops/status.js";
export { Repository } from "../core/repository.js";
export type { Worktree, WorktreeDirent, WorktreeStat } from "../core/worktree.js";
export type { SqlDatabase } from "../sqlite/db.js";
export { initializeGitSchema, SCHEMA_VERSION } from "../sqlite/schema.js";
export {
  type IndexEntry,
  RepoStore,
  type RepositoryRow,
  SqliteGitDatabase,
  type StoreOptions,
} from "../sqlite/store.js";
export {
  type CreateGitOptions,
  createGit,
  type Git,
  type GitAddOptions,
  type GitBranchDeleteOptions,
  type GitBranchOptions,
  type GitCatFileOptions,
  type GitCatFileResult,
  type GitCheckoutOptions,
  type GitCherryPickContinueOptions,
  type GitCherryPickOptions,
  type GitCleanOptions,
  type GitCloneOptions,
  type GitCommitOptions,
  type GitConfigGetOptions,
  type GitConfigSetOptions,
  type GitDiffOptions,
  type GitDirOptions,
  type GitFactory,
  type GitFetchOptions,
  type GitHashObjectOptions,
  type GitInitOptions,
  type GitMergeContinueOptions,
  type GitMergeOptions,
  type GitPullOptions,
  type GitPushOptions,
  type GitRebaseContinueOptions,
  type GitRebaseOptions,
  type GitRemoteAddOptions,
  type GitRemoteRemoveOptions,
  type GitResetOptions,
  type GitRevertContinueOptions,
  type GitRevertOptions,
  type GitRmOptions,
  type GitTagDeleteOptions,
  type GitTagOptions,
  type GitUpdateRefOptions,
  type GitWorkspaceBinding,
} from "./client.js";
