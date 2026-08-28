import {
  type ExactRootStateSource,
  type GitContext,
  type GitIdentity,
  type IndexTrackerWriter,
  type InitialWorktreeWriter,
  nestedRoots,
  openRepository,
} from "../core/context.js";
import { GitError, UnsupportedOperationError } from "../core/errors.js";
import {
  type CherryPickContinueOptions,
  type CherryPickOptions,
  cherryPickAbort as cherryPickAbortOp,
  cherryPickContinue as cherryPickContinueOp,
  cherryPick as cherryPickOp,
  cherryPickSkip as cherryPickSkipOp,
} from "../core/ops/cherry-pick.js";
import { type CommitOptions, commit as commitOp } from "../core/ops/commit.js";
import {
  type ConfigGetOptions,
  type ConfigSetOptions,
  configGet,
  configSet,
  type RemoteAddOptions,
  type RemoteGetUrlOptions,
  type RemoteRemoveOptions,
  type RemoteSetUrlOptions,
  remoteAdd,
  remoteGetUrl,
  remoteList,
  remoteRemove,
  remoteSetUrl,
} from "../core/ops/config.js";
import {
  type DiffOptions,
  diff as diffOp,
  diffSummary as diffSummaryOp,
} from "../core/ops/diff.js";
import { type InitOptions, initRepository } from "../core/ops/init.js";
import type {
  CommitResult,
  DiffSummaryEntry,
  MergeResult,
  RebaseResult,
  RemoteView,
  ReplayResult,
  StatusEntry,
} from "../core/ops/kinds.js";
import { type LsRemoteOptions, lsRemote as lsRemoteOp } from "../core/ops/ls-remote.js";
import { type MaintenanceResult, maintenance as maintenanceOp } from "../core/ops/maintenance.js";
import {
  type MergeContinueOptions,
  type MergeOptions,
  mergeAbort as mergeAbortOp,
  mergeContinue as mergeContinueOp,
  merge as mergeOp,
} from "../core/ops/merge.js";
import {
  type DivergenceOptions,
  type DivergenceResult,
  divergence as divergenceOp,
  type MergeBaseOptions,
  type MergeBaseResult,
  mergeBase as mergeBaseOp,
} from "../core/ops/merge-base.js";
import {
  type CloneOptions,
  clone as cloneOp,
  type FetchOptions,
  fetchInto,
  validateFetchOptions,
} from "../core/ops/network.js";
import type {
  FetchResult as StructuredFetchResult,
  LsRemoteResult as StructuredLsRemoteResult,
  PushResult as StructuredPushResult,
} from "../core/ops/refspec.js";

export type {
  FetchRefspec,
  FetchRefUpdate,
  FetchResult,
  LsRemoteResult,
  PushRefStatus,
  PushRefspec,
  PushResult,
  PushTrackingResult,
  RemoteRefView,
  RemoteTarget,
} from "../core/ops/refspec.js";

import {
  type CatFileOptions,
  type CommitTreeOptions,
  catFile as catFileOp,
  commitTree as commitTreeOp,
  type HashObjectOptions,
  hashObject as hashObjectOp,
  type RawRefTarget,
  type ReadRefOptions,
  type ReadTreeOptions,
  readRef as readRefOp,
  readTree as readTreeOp,
  repoRoot as repoRootOp,
  type UpdateRefOptions,
  updateRef as updateRefOp,
  writeTree as writeTreeOp,
} from "../core/ops/plumbing.js";
import { type PullOptions, pull as pullOp } from "../core/ops/pull.js";
import { type PushOptions, push as pushOp } from "../core/ops/push.js";
import {
  type CommitView,
  catFile as catFileRead,
  type LsTreeOptions,
  log as logOp,
  lsFilesAtRef,
  lsTree as lsTreeOp,
  show as showOp,
  type TreeEntryView,
} from "../core/ops/reads.js";
import {
  type RebaseContinueOptions,
  type RebaseStartOptions,
  rebaseAbort as rebaseAbortOp,
  rebaseContinue as rebaseContinueOp,
  rebase as rebaseOp,
  rebaseSkip as rebaseSkipOp,
} from "../core/ops/rebase.js";
import {
  type RecoverRefOptions,
  type RefLogEntry,
  type RefLogReadOptions,
  recoverRef as recoverRefOp,
  reflog as reflogOp,
} from "../core/ops/ref-log.js";
import {
  type BranchDeleteOptions,
  type BranchOptions,
  type BranchRenameOptions,
  branchDelete as branchDeleteOp,
  branchList as branchListOp,
  branch as branchOp,
  branchRename as branchRenameOp,
  type CheckoutOptions,
  type CurrentBranchOptions,
  checkout as checkoutOp,
  currentBranch as currentBranchOp,
  type TagDeleteOptions,
  type TagOptions,
  tagDelete as tagDeleteOp,
  tagList as tagListOp,
  tag as tagOp,
} from "../core/ops/refs.js";
import {
  type ReplaySnapshotOptions,
  type ReplaySnapshotResult,
  replaySnapshot as replaySnapshotOp,
} from "../core/ops/replay.js";
import {
  type RevertContinueOptions,
  type RevertOptions,
  revertAbort as revertAbortOp,
  revertContinue as revertContinueOp,
  revert as revertOp,
  revertSkip as revertSkipOp,
} from "../core/ops/revert.js";
import {
  type AddOptions,
  add as addOp,
  type LsFilesWorktreeOptions,
  lsFilesWithWorktree,
  type ResetOptions,
  type RmOptions,
  reset as resetOp,
  rm as rmOp,
} from "../core/ops/staging.js";
import {
  type CleanOptions,
  clean as cleanOp,
  eagerStatus,
  type StatusBranch,
  type StatusDetail,
  type StatusOptions,
  type StatusReportOptions,
  statusBranch,
} from "../core/ops/status.js";
import {
  type WorktreeAddOptions,
  type WorktreeInfo,
  type WorktreeRemoveOptions,
  worktreeAdd as worktreeAddOp,
  worktreeList as worktreeListOp,
  worktreePrune as worktreePruneOp,
  worktreeRemove as worktreeRemoveOp,
} from "../core/ops/worktrees.js";
import type { GitHttpClient } from "../core/protocol/transport.js";
import type { Repository } from "../core/repository.js";
import type {
  CommitTreeSnapshotSource,
  SelectedPathSource,
  SparseWorkspaceSource,
} from "../core/sparse-workspace.js";
import type { Worktree } from "../core/worktree.js";
import type { SqliteGitDatabase } from "../sqlite/store.js";
import { createContextGitCliRunner } from "./cli/index.js";
import type { GitCliInput, GitCliResult, GitCliRunner, GitCliRunOptions } from "./cli/types.js";

export interface GitDirOptions {
  dir?: string;
}

export type GitCloneOptions = CloneOptions;
export type GitFetchOptions = GitDirOptions & FetchOptions;
export type GitLsRemoteOptions = GitDirOptions & LsRemoteOptions;
export type GitInitOptions = InitOptions;
export type GitDiffOptions = DiffOptions & GitDirOptions;
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
  log(input?: GitDirOptions & { ref?: string; depth?: number }): Promise<CommitView[]>;
  show(input: GitDirOptions & { ref: string }): Promise<CommitView>;
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
  pull(input?: GitPullOptions): Promise<MergeResult>;
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
  yieldNow?: () => Promise<void>;
}

export interface CreateGitOptions {
  now?: () => number;
  timezoneOffset?: () => number;
  yieldNow?: () => Promise<void>;
}

export type GitFactory = (binding: GitWorkspaceBinding) => Git;

/** Create a Git factory that binds lazily to one Workspace database. */
export function createGit(options: CreateGitOptions = {}): GitFactory {
  return (binding) => createGitClient(binding, options);
}

function remoteOptionsDir(options: unknown, operation: string): string | undefined {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitError("EINVAL", `${operation} options must be an object`);
  }
  const dir = Reflect.get(options, "dir");
  if (dir !== undefined && typeof dir !== "string") {
    throw new GitError("EINVAL", `${operation} dir must be a string`);
  }
  return dir;
}

function createGitClient(binding: GitWorkspaceBinding, options: CreateGitOptions): Git {
  const context: GitContext = {
    database: binding.database,
    worktree: binding.worktree,
    now: options.now ?? binding.now,
    timezoneOffset: options.timezoneOffset ?? binding.timezoneOffset,
  };
  if (binding.defaultIdentity !== undefined) context.defaultIdentity = binding.defaultIdentity;
  if (binding.exactRootStates !== undefined) context.exactRootStates = binding.exactRootStates;
  if (binding.http !== undefined) context.http = binding.http;
  if (binding.initialWorktree !== undefined) context.initialWorktree = binding.initialWorktree;
  if (binding.indexTracker !== undefined) context.indexTracker = binding.indexTracker;
  if (binding.sparseWorkspace !== undefined) context.sparseWorkspace = binding.sparseWorkspace;
  if (binding.selectedPaths !== undefined) context.selectedPaths = binding.selectedPaths;
  if (binding.commitTrees !== undefined) context.commitTrees = binding.commitTrees;
  const yieldNow = options.yieldNow ?? binding.yieldNow;
  if (yieldNow !== undefined) context.yieldNow = yieldNow;
  const cliRunner = createContextGitCliRunner(context);

  const at = (dir?: string): Repository => openRepository(context, dir ?? "/");
  const excludeRoots = (repo: Repository): string[] => nestedRoots(context, repo.root);

  return {
    async clone(input) {
      await cloneOp(context, input);
    },
    async fetch(input = {}) {
      validateFetchOptions(input);
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      return fetchInto(context, repo, input);
    },
    async lsRemote(input = {}) {
      return lsRemoteOp(context, at(input.dir), input);
    },
    async init(input = {}) {
      initRepository(context, input);
    },
    async status(input = {}) {
      const { dir, ...statusOptions } = input;
      const repo = at(dir);
      return eagerStatus(
        repo,
        context.worktree,
        { ...statusOptions, excludeRoots: excludeRoots(repo) },
        context,
      ).map(publicStatusEntry);
    },
    async statusReport(input = {}) {
      const { branch, dir, ...statusOptions } = input;
      const repo = at(dir);
      const entries = eagerStatus(
        repo,
        context.worktree,
        { ...statusOptions, excludeRoots: excludeRoots(repo) },
        context,
      ).map(publicStatusEntry);
      return branch === true ? { entries, branch: statusBranch(repo) } : { entries };
    },
    async diff(input = {}) {
      return diffOp(at(input.dir), context.worktree, input, context.sparseWorkspace);
    },
    async diffSummary(input = {}) {
      return diffSummaryOp(at(input.dir), context.worktree, input, context.sparseWorkspace);
    },
    async clean(input = {}) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      return cleanOp(repo, context.worktree, { ...input, excludeRoots: excludeRoots(repo) });
    },
    async add(input) {
      const repo = at(input.dir);
      addOp(repo, context.worktree, { ...input, excludeRoots: excludeRoots(repo) }, context);
    },
    async rm(input) {
      const repo = at(input.dir);
      rmOp(repo, context.worktree, { ...input, excludeRoots: excludeRoots(repo) });
    },
    async reset(input = {}) {
      const repo = at(input.dir);
      if (input.hard === true) {
        repo.store.db.transactionSync(() => {
          resetOp(context, repo, context.worktree, input);
          repo.checkout.clearOperationState();
        });
        return;
      }
      repo.checkout.requireNoOperationState();
      resetOp(context, repo, context.worktree, input);
    },
    async commit(input) {
      const repo = at(input.dir);
      const operation = repo.checkout.readOperationState();
      if (operation?.kind === "merge") {
        if (input.amend === true) {
          throw new GitError("EINVAL", "cannot amend while continuing a merge");
        }
        const result = mergeContinueOp(context, repo, input);
        if (result.oid === undefined) {
          throw new GitError("ECORRUPT", "merge continuation did not create a commit");
        }
        return { oid: result.oid };
      }
      if (operation !== null) repo.checkout.requireNoOperationState();
      return commitOp(context, repo, input);
    },
    async log(input = {}) {
      return logOp(at(input.dir), input);
    },
    async show(input) {
      return showOp(at(input.dir), input.ref);
    },
    async revParse(input) {
      return at(input.dir).revParse(input.ref);
    },
    async tryRevParse(input) {
      return at(input.dir).tryRevParse(input.ref);
    },
    async divergence(input) {
      return divergenceOp(at(input.dir), input);
    },
    async mergeBase(input) {
      return mergeBaseOp(at(input.dir), input);
    },
    async readRef(input) {
      return readRefOp(at(input.dir), input);
    },
    async worktreeAdd(input) {
      return worktreeAddOp(context, at(input.dir), input);
    },
    async worktreeList(input = {}) {
      return worktreeListOp(context, at(input.dir));
    },
    async worktreeRemove(input) {
      worktreeRemoveOp(context, at(input.dir), input);
    },
    async worktreePrune(input = {}) {
      return worktreePruneOp(context, at(input.dir));
    },
    async reflog(input = {}) {
      return reflogOp(at(input.dir), input);
    },
    async recoverRef(input) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      recoverRefOp(context, repo, input);
    },
    async repoRoot(input = {}) {
      return repoRootOp(context, input);
    },
    async maintenance(input = {}) {
      return maintenanceOp(context, at(input.dir));
    },
    async currentBranch(input = {}) {
      return currentBranchOp(at(input.dir), input);
    },
    async lsFiles(input = {}) {
      const { dir, ref, ...lsFilesOptions } = input;
      const repo = at(dir);
      if (ref !== undefined) {
        rejectRefWorktreeSelection(input);
        return lsFilesAtRef(repo, ref, lsFilesOptions);
      }
      return lsFilesWithWorktree(repo, context.worktree, {
        ...lsFilesOptions,
        excludeRoots: excludeRoots(repo),
      });
    },
    async lsTree(input) {
      return lsTreeOp(at(input.dir), input.ref, input.path, { recursive: input.recursive });
    },
    async branch(input) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      branchOp(context, repo, input);
    },
    async branchDelete(input) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      branchDeleteOp(context, repo, input);
    },
    async branchRename(input) {
      branchRenameOp(context, at(input.dir), input);
    },
    async branchList(input = {}) {
      return branchListOp(at(input.dir));
    },
    async tag(input) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      tagOp(context, repo, input);
    },
    async tagDelete(input) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      tagDeleteOp(context, repo, input);
    },
    async tagList(input = {}) {
      return tagListOp(at(input.dir));
    },
    async checkout(input) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      checkoutOp(context, repo, context.worktree, input);
    },
    async remoteAdd(input) {
      remoteAdd(at(input.dir), input);
    },
    async remoteGetUrl(input) {
      return remoteGetUrl(at(remoteOptionsDir(input, "remote get-url")), input);
    },
    async remoteRemove(input) {
      remoteRemove(at(input.dir), input);
    },
    async remoteSetUrl(input) {
      remoteSetUrl(at(remoteOptionsDir(input, "remote set-url")), input);
    },
    async remoteList(input = {}) {
      return remoteList(at(input.dir));
    },
    async configGet(input) {
      return configGet(at(input.dir), input);
    },
    async configSet(input) {
      configSet(at(input.dir), input);
    },
    async hashObject(input) {
      return hashObjectOp(at(input.dir), input);
    },
    async catFile(input) {
      const repo = at(input.dir);
      const result =
        input.filepath === undefined
          ? catFileOp(repo, input)
          : catFileRead(repo, input.oid, input.filepath);
      return { oid: result.oid, bytes: result.bytes };
    },
    async readTree(input) {
      const { dir, ...readOptions } = input;
      readTreeOp(at(dir), context.worktree, readOptions);
    },
    async writeTree(input = {}) {
      return writeTreeOp(at(input.dir));
    },
    async commitTree(input) {
      const { dir, ...commitOptions } = input;
      return commitTreeOp(context, at(dir), commitOptions);
    },
    async withScratchIndex(input, body) {
      const repo = at(input.dir);
      return repo.store.withScratchIndex(input.name, (index) => {
        let active = true;
        const requireActive = (): void => {
          if (!active) throw new GitError("EINVAL", "scratch index session is no longer active");
        };
        const scratch: GitScratchIndex = {
          readTree(readOptions) {
            requireActive();
            readTreeOp(repo, context.worktree, readOptions, index);
          },
          add(addOptions) {
            requireActive();
            addOp(
              repo,
              context.worktree,
              { ...addOptions, excludeRoots: excludeRoots(repo) },
              context,
              index,
            );
          },
          writeTree() {
            requireActive();
            return writeTreeOp(repo, index);
          },
          commitTree(commitOptions) {
            requireActive();
            return commitTreeOp(context, repo, commitOptions);
          },
          replaySnapshot(replayOptions) {
            requireActive();
            return replaySnapshotOp(repo, index, replayOptions);
          },
        };
        try {
          return body(scratch);
        } finally {
          active = false;
        }
      });
    },
    async updateRef(input) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      updateRefOp(context, repo, input);
    },
    async push(input = {}) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      return pushOp(context, repo, input);
    },
    async pull(input = {}) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      return pullOp(context, repo, context.worktree, input);
    },
    async merge(input) {
      const repo = at(input.dir);
      return mergeOp(context, repo, context.worktree, input);
    },
    async mergeContinue(input = {}) {
      return mergeContinueOp(context, at(input.dir), input);
    },
    async mergeAbort(input = {}) {
      mergeAbortOp(at(input.dir), context.worktree);
    },
    async cherryPick(input) {
      return cherryPickOp(context, at(input.dir), context.worktree, input);
    },
    async cherryPickContinue(input = {}) {
      return cherryPickContinueOp(context, at(input.dir), input);
    },
    async cherryPickSkip(input = {}) {
      cherryPickSkipOp(at(input.dir), context.worktree);
    },
    async cherryPickAbort(input = {}) {
      cherryPickAbortOp(at(input.dir), context.worktree);
    },
    async revert(input) {
      return revertOp(context, at(input.dir), context.worktree, input);
    },
    async revertContinue(input = {}) {
      return revertContinueOp(context, at(input.dir), input);
    },
    async revertSkip(input = {}) {
      revertSkipOp(at(input.dir), context.worktree);
    },
    async revertAbort(input = {}) {
      revertAbortOp(at(input.dir), context.worktree);
    },
    async rebase(input) {
      return rebaseOp(context, at(input.dir), context.worktree, input);
    },
    async rebaseContinue(input = {}) {
      return rebaseContinueOp(context, at(input.dir), context.worktree, input);
    },
    async rebaseSkip(input = {}) {
      return rebaseSkipOp(context, at(input.dir), context.worktree, input);
    },
    async rebaseAbort(input = {}) {
      rebaseAbortOp(at(input.dir), context.worktree);
    },
    async stashPush() {
      throw new UnsupportedOperationError("stash push");
    },
    async stashList() {
      throw new UnsupportedOperationError("stash list");
    },
    async stashPop() {
      throw new UnsupportedOperationError("stash pop");
    },
    runCli(input: GitCliInput, runOptions?: GitCliRunOptions) {
      return cliRunner.runCli(input, runOptions);
    },
    async cli(input) {
      return cliRunner.runCli(input);
    },
  };
}

function rejectRefWorktreeSelection(input: GitLsFilesOptions): void {
  for (const key of ["cached", "others", "excludeStandard"]) {
    if (Reflect.has(input, key)) {
      throw new GitError("EINVAL", `ls-files ${key} is unavailable with ref`);
    }
  }
}

function publicStatusEntry(row: StatusDetail): StatusEntry {
  if (row.renamed === true) {
    return {
      path: row.path,
      index: row.index,
      worktree: row.worktree,
      originalPath: row.originalPath,
      similarity: row.similarity,
    };
  }
  return { path: row.path, index: row.index, worktree: row.worktree };
}
