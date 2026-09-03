import type { GitCliInput, GitCliResult, GitCliRunner } from "./cli/types.js";
import type { CherryPickContinueOptions, CherryPickOptions } from "./ops/cherry-pick.js";
import type { CommitOptions } from "./ops/commit.js";
import type {
  ConfigGetOptions,
  ConfigSetOptions,
  RemoteAddOptions,
  RemoteGetUrlOptions,
  RemoteRemoveOptions,
  RemoteSetUrlOptions,
} from "./ops/config.js";
import type {
  ExactRootStateSource,
  GitCliNetworkBinding,
  GitIdentity,
  IndexTrackerWriter,
  InitialWorktreeWriter,
} from "./ops/context.js";
import type { DiffOptions } from "./ops/diff.js";
import type { InitOptions } from "./ops/init.js";
import type {
  CommitResult,
  DiffSummaryEntry,
  MergeResult,
  PullResult,
  RebaseResult,
  RemoteView,
  ReplayResult,
  StatusEntry,
} from "./ops/kinds.js";
import type { LsRemoteOptions } from "./ops/ls-remote.js";
import type { MaintenanceResult } from "./ops/maintenance.js";
import type { MergeContinueOptions, MergeOptions } from "./ops/merge.js";
import type {
  DivergenceOptions,
  DivergenceResult,
  MergeBaseOptions,
  MergeBaseResult,
} from "./ops/merge-base.js";
import type { AbortableNetworkOptions, CloneOptions, FetchOptions } from "./ops/network.js";
import type {
  CatFileOptions,
  CommitTreeOptions,
  HashObjectOptions,
  RawRefTarget,
  ReadRefOptions,
  ReadTreeOptions,
  UpdateRefOptions,
} from "./ops/plumbing.js";
import type { PullOptions } from "./ops/pull.js";
import type { PushOptions } from "./ops/push.js";
import type {
  CommitView,
  LogOptions,
  LsTreeOptions,
  ShowOptions,
  ShowResult,
  TreeEntryView,
} from "./ops/reads.js";
import type { RebaseContinueOptions, RebaseStartOptions } from "./ops/rebase.js";
import type { RecoverRefOptions, RefLogEntry, RefLogReadOptions } from "./ops/ref-log.js";
import type {
  BranchDeleteOptions,
  BranchOptions,
  BranchRenameOptions,
  CheckoutOptions,
  CurrentBranchOptions,
  TagDeleteOptions,
  TagOptions,
} from "./ops/refs.js";
import type {
  FetchResult as StructuredFetchResult,
  LsRemoteResult as StructuredLsRemoteResult,
  PushResult as StructuredPushResult,
} from "./ops/refspec.js";
import type { ReplaySnapshotOptions, ReplaySnapshotResult } from "./ops/replay.js";
import type { RevertContinueOptions, RevertOptions } from "./ops/revert.js";
import type {
  CommitTreeSnapshotSource,
  SelectedPathSource,
  SparseWorkspaceSource,
} from "./ops/sparse-workspace.js";
import type { AddOptions, LsFilesWorktreeOptions, ResetOptions, RmOptions } from "./ops/staging.js";
import type {
  CleanOptions,
  StatusBranch,
  StatusOptions,
  StatusReportOptions,
} from "./ops/status.js";
import type { Worktree } from "./ops/worktree.js";
import type { WorktreeAddOptions, WorktreeInfo, WorktreeRemoveOptions } from "./ops/worktrees.js";
import type { AuthCallback, GitHttpClient } from "./protocol/transport.js";
import type { SqliteGitDatabase } from "./store/database.js";

export type { PullResult } from "./ops/kinds.js";
export type { AbortableNetworkOptions, CloneOptions, FetchOptions } from "./ops/network.js";
export type { PushOptions } from "./ops/push.js";
export type {
  FetchRefspec,
  FetchRefUpdate,
  FetchResult,
  LsRemoteResult,
  PushLeaseExpectation,
  PushRefStatus,
  PushRefspec,
  PushResult,
  PushTrackingResult,
  RemoteRefView,
  RemoteTarget,
} from "./ops/refspec.js";

export interface GitDirOptions {
  dir?: string;
}

export type GitAbortableNetworkOptions = AbortableNetworkOptions;
export type GitCloneOptions = CloneOptions;
export type GitPromisorAuth = AuthCallback;
export type GitFetchOptions = GitDirOptions & FetchOptions;
export type GitLsRemoteOptions = GitDirOptions & LsRemoteOptions;
export type GitInitOptions = InitOptions;
export type GitDiffOptions = DiffOptions & GitDirOptions;
export type GitLogOptions = LogOptions & GitDirOptions;
export type GitShowOptions = ShowOptions & GitDirOptions;
export type GitShowResult = ShowResult;
export type GitCleanOptions = Omit<CleanOptions, "excludeRoots" | "ignores"> & GitDirOptions;
export type GitStatusOptions = Omit<StatusOptions, "excludeRoots" | "ignores"> & GitDirOptions;
export type GitStatusReportOptions = Omit<StatusReportOptions, "excludeRoots" | "ignores"> &
  GitDirOptions;
export type GitAddOptions = Omit<AddOptions, "excludeRoots"> & GitDirOptions;
export type GitRmOptions = Omit<RmOptions, "excludeRoots"> & GitDirOptions;
export type GitResetOptions = ResetOptions & GitDirOptions;
export type GitCommitOptions = CommitOptions & GitDirOptions;
export type GitRevParseOptions = GitDirOptions & { ref: string };
export type GitMergeOptions = MergeOptions & GitDirOptions;
export type GitMergeContinueOptions = MergeContinueOptions & GitDirOptions;
export type GitCherryPickOptions = CherryPickOptions & GitDirOptions;
export type GitCherryPickContinueOptions = CherryPickContinueOptions & GitDirOptions;
export type GitRevertOptions = RevertOptions & GitDirOptions;
export type GitRevertContinueOptions = RevertContinueOptions & GitDirOptions;
export type GitRebaseOptions = RebaseStartOptions & GitDirOptions;
export type GitRebaseContinueOptions = RebaseContinueOptions & GitDirOptions;
export type GitBranchOptions = BranchOptions & GitDirOptions;
export type GitBranchDeleteOptions = BranchDeleteOptions & GitDirOptions;
export type GitBranchRenameOptions = BranchRenameOptions & GitDirOptions;
export type GitTagOptions = TagOptions & GitDirOptions;
export type GitTagDeleteOptions = TagDeleteOptions & GitDirOptions;
export type GitCheckoutOptions = CheckoutOptions & GitDirOptions;
export type GitConfigGetOptions = ConfigGetOptions & GitDirOptions;
export type GitConfigSetOptions = ConfigSetOptions & GitDirOptions;
export type GitRemoteAddOptions = RemoteAddOptions & GitDirOptions;
export type GitRemoteGetUrlOptions = RemoteGetUrlOptions & GitDirOptions;
export type GitRemoteRemoveOptions = RemoteRemoveOptions & GitDirOptions;
export type GitRemoteSetUrlOptions = RemoteSetUrlOptions & GitDirOptions;
export type GitHashObjectOptions = HashObjectOptions & GitDirOptions;
export type GitCatFileOptions = CatFileOptions & GitDirOptions;
export type GitReadTreeOptions = ReadTreeOptions & GitDirOptions;
export type GitWriteTreeOptions = GitDirOptions;
export type GitCommitTreeOptions = CommitTreeOptions & GitDirOptions;
export type GitUpdateRefOptions = UpdateRefOptions & GitDirOptions;
export type GitDivergenceOptions = DivergenceOptions & GitDirOptions;
export type GitMergeBaseOptions = MergeBaseOptions & GitDirOptions;
export type GitLsFilesOptions = Omit<LsFilesWorktreeOptions, "excludeRoots"> &
  GitDirOptions & { ref?: string };
export type GitLsTreeOptions = LsTreeOptions & GitDirOptions & { ref: string; path?: string };
export type GitReadRefOptions = ReadRefOptions & GitDirOptions;
export type GitRefLogOptions = RefLogReadOptions & GitDirOptions;
export type GitRecoverRefOptions = RecoverRefOptions & GitDirOptions;
export type GitWorktreeAddOptions = WorktreeAddOptions & GitDirOptions;
export type GitWorktreeRemoveOptions = WorktreeRemoveOptions & GitDirOptions;
export type GitPushOptions = PushOptions & GitDirOptions;
export type GitPullOptions = PullOptions & GitDirOptions;
export type GitMaintenanceOptions = GitDirOptions;
export type GitMaintenanceResult = MaintenanceResult;

export interface GitCatFileResult {
  oid: string;
  bytes: Uint8Array;
}

export interface GitStatusReport {
  entries: StatusEntry[];
  branch?: StatusBranch;
}

export type GitScratchReadTreeOptions = ReadTreeOptions;
export type GitScratchAddOptions = Omit<AddOptions, "excludeRoots">;
export type GitScratchCommitTreeOptions = CommitTreeOptions;
export type GitScratchReplaySnapshotOptions = ReplaySnapshotOptions;

/** Synchronous operations scoped to one transaction-owned scratch index. */
export interface GitScratchIndex {
  readTree(input: GitScratchReadTreeOptions): void;
  add(input: GitScratchAddOptions): void;
  writeTree(): string;
  commitTree(input: GitScratchCommitTreeOptions): string;
  replaySnapshot(input: GitScratchReplaySnapshotOptions): ReplaySnapshotResult;
}

export interface GitScratchIndexOptions extends GitDirOptions {
  name: string;
}

export type GitScratchIndexCallback<T> = (index: GitScratchIndex) => T;

export interface Git extends GitCliRunner {
  clone(input: GitCloneOptions): Promise<void>;
  fetch(input?: GitFetchOptions): Promise<StructuredFetchResult>;
  lsRemote(input?: GitLsRemoteOptions): Promise<StructuredLsRemoteResult>;
  init(input?: GitInitOptions): Promise<void>;
  status(input?: GitStatusOptions): Promise<StatusEntry[]>;
  statusReport(input?: GitStatusReportOptions): Promise<GitStatusReport>;
  diff(input?: GitDiffOptions): Promise<string>;
  diffSummary(input?: GitDiffOptions): Promise<DiffSummaryEntry[]>;
  clean(input?: GitCleanOptions): Promise<string[]>;
  add(input: GitAddOptions): Promise<void>;
  rm(input: GitRmOptions): Promise<void>;
  reset(input?: GitResetOptions): Promise<void>;
  commit(input: GitCommitOptions): Promise<CommitResult>;
  log(input?: GitLogOptions): Promise<CommitView[]>;
  show(input: GitShowOptions): Promise<GitShowResult>;
  revParse(input: GitRevParseOptions): Promise<string>;
  tryRevParse(input: GitRevParseOptions): Promise<string | undefined>;
  divergence(input: GitDivergenceOptions): Promise<DivergenceResult>;
  mergeBase(input: GitMergeBaseOptions): Promise<MergeBaseResult>;
  readRef(input: GitReadRefOptions): Promise<RawRefTarget>;
  worktreeAdd(input: GitWorktreeAddOptions): Promise<WorktreeInfo>;
  worktreeList(input?: GitDirOptions): Promise<readonly WorktreeInfo[]>;
  worktreeRemove(input: GitWorktreeRemoveOptions): Promise<void>;
  worktreePrune(input?: GitDirOptions): Promise<readonly WorktreeInfo[]>;
  reflog(input?: GitRefLogOptions): Promise<RefLogEntry[]>;
  recoverRef(input: GitRecoverRefOptions): Promise<void>;
  repoRoot(input?: GitDirOptions): Promise<string>;
  maintenance(input?: GitMaintenanceOptions): Promise<GitMaintenanceResult>;
  currentBranch(input?: GitDirOptions & CurrentBranchOptions): Promise<string | undefined>;
  lsFiles(input?: GitLsFilesOptions): Promise<string[]>;
  lsTree(input: GitLsTreeOptions): Promise<TreeEntryView[]>;
  branch(input: GitBranchOptions): Promise<void>;
  branchDelete(input: GitBranchDeleteOptions): Promise<void>;
  branchRename(input: GitBranchRenameOptions): Promise<void>;
  branchList(input?: GitDirOptions): Promise<string[]>;
  tag(input: GitTagOptions): Promise<void>;
  tagDelete(input: GitTagDeleteOptions): Promise<void>;
  tagList(input?: GitDirOptions): Promise<string[]>;
  checkout(input: GitCheckoutOptions): Promise<void>;
  remoteAdd(input: GitRemoteAddOptions): Promise<void>;
  remoteGetUrl(input: GitRemoteGetUrlOptions): Promise<string>;
  remoteRemove(input: GitRemoteRemoveOptions): Promise<void>;
  remoteSetUrl(input: GitRemoteSetUrlOptions): Promise<void>;
  remoteList(input?: GitDirOptions): Promise<RemoteView[]>;
  configGet(input: GitConfigGetOptions): Promise<string | string[] | undefined>;
  configSet(input: GitConfigSetOptions): Promise<void>;
  hashObject(input: GitHashObjectOptions): Promise<string>;
  catFile(input: GitCatFileOptions): Promise<GitCatFileResult>;
  readTree(input: GitReadTreeOptions): Promise<void>;
  writeTree(input?: GitWriteTreeOptions): Promise<string>;
  commitTree(input: GitCommitTreeOptions): Promise<string>;
  withScratchIndex<T>(input: GitScratchIndexOptions, body: GitScratchIndexCallback<T>): Promise<T>;
  updateRef(input: GitUpdateRefOptions): Promise<void>;
  push(input?: GitPushOptions): Promise<StructuredPushResult>;
  pull(input?: GitPullOptions): Promise<PullResult>;
  merge(input: GitMergeOptions): Promise<MergeResult>;
  mergeContinue(input?: GitMergeContinueOptions): Promise<MergeResult>;
  mergeAbort(input?: GitDirOptions): Promise<void>;
  cherryPick(input: GitCherryPickOptions): Promise<ReplayResult>;
  cherryPickContinue(input?: GitCherryPickContinueOptions): Promise<ReplayResult>;
  cherryPickSkip(input?: GitDirOptions): Promise<void>;
  cherryPickAbort(input?: GitDirOptions): Promise<void>;
  revert(input: GitRevertOptions): Promise<ReplayResult>;
  revertContinue(input?: GitRevertContinueOptions): Promise<ReplayResult>;
  revertSkip(input?: GitDirOptions): Promise<void>;
  revertAbort(input?: GitDirOptions): Promise<void>;
  rebase(input: GitRebaseOptions): Promise<RebaseResult>;
  rebaseContinue(input?: GitRebaseContinueOptions): Promise<RebaseResult>;
  rebaseSkip(input?: GitRebaseContinueOptions): Promise<RebaseResult>;
  rebaseAbort(input?: GitDirOptions): Promise<void>;
  stashPush(input?: GitDirOptions): Promise<never>;
  stashList(input?: GitDirOptions): Promise<never>;
  stashPop(input?: GitDirOptions): Promise<never>;
  cli(input: GitCliInput): Promise<GitCliResult>;
}

export interface GitWorkspaceBinding {
  database: SqliteGitDatabase;
  worktree: Worktree;
  exactRootStates?: ExactRootStateSource;
  initialWorktree?: InitialWorktreeWriter;
  indexTracker?: IndexTrackerWriter;
  sparseWorkspace?: SparseWorkspaceSource;
  selectedPaths?: SelectedPathSource;
  commitTrees?: CommitTreeSnapshotSource;
  now: () => number;
  timezoneOffset: () => number;
  defaultIdentity?: GitIdentity;
  http?: GitHttpClient;
  promisorAuth?: AuthCallback;
  promisorHeaders?: Record<string, string>;
  cliNetwork?: GitCliNetworkBinding;
  yieldNow?: () => Promise<void>;
}

export interface CreateGitOptions {
  now?: () => number;
  timezoneOffset?: () => number;
  yieldNow?: () => Promise<void>;
}

export type GitFactory = (binding: GitWorkspaceBinding) => Git;
