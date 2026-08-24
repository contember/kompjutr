import {
  type GitContext,
  type GitIdentity,
  type IndexTrackerWriter,
  type InitialWorktreeWriter,
  nestedRoots,
  openRepository,
} from "../core/context.js";
import { GitError, UnsupportedOperationError } from "../core/errors.js";
import { type CommitOptions, commit as commitOp } from "../core/ops/commit.js";
import {
  type ConfigGetOptions,
  type ConfigSetOptions,
  configGet,
  configSet,
  type RemoteAddOptions,
  type RemoteRemoveOptions,
  remoteAdd,
  remoteList,
  remoteRemove,
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
  PushResult,
  RemoteView,
  StatusEntry,
} from "../core/ops/kinds.js";
import {
  type MergeContinueOptions,
  type MergeOptions,
  mergeAbort as mergeAbortOp,
  mergeContinue as mergeContinueOp,
  merge as mergeOp,
} from "../core/ops/merge.js";
import {
  type CloneOptions,
  clone as cloneOp,
  type FetchOptions,
  type FetchResult,
  fetchInto,
} from "../core/ops/network.js";
import {
  type CatFileOptions,
  catFile as catFileOp,
  type HashObjectOptions,
  hashObject as hashObjectOp,
  repoRoot as repoRootOp,
  type UpdateRefOptions,
  updateRef as updateRefOp,
} from "../core/ops/plumbing.js";
import { type PullOptions, pull as pullOp } from "../core/ops/pull.js";
import { type PushOptions, push as pushOp } from "../core/ops/push.js";
import {
  type CommitView,
  catFile as catFileRead,
  log as logOp,
  lsFilesAtRef,
  lsTree as lsTreeOp,
  show as showOp,
  type TreeEntryView,
} from "../core/ops/reads.js";
import {
  type BranchDeleteOptions,
  type BranchOptions,
  branchDelete as branchDeleteOp,
  branchList as branchListOp,
  branch as branchOp,
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
  type AddOptions,
  add as addOp,
  lsFiles as lsFilesOp,
  type ResetOptions,
  type RmOptions,
  reset as resetOp,
  rm as rmOp,
} from "../core/ops/staging.js";
import { type CleanOptions, clean as cleanOp, eagerStatus } from "../core/ops/status.js";
import type { GitHttpClient } from "../core/protocol/transport.js";
import type { Repository } from "../core/repository.js";
import type { SparseWorkspaceSource } from "../core/sparse-workspace.js";
import type { Worktree } from "../core/worktree.js";
import type { SqliteGitDatabase } from "../sqlite/store.js";

export interface GitDirOptions {
  dir?: string;
}

export type GitCloneOptions = CloneOptions;
export type GitFetchOptions = FetchOptions;
export type GitInitOptions = InitOptions;
export type GitDiffOptions = DiffOptions & GitDirOptions;
export type GitCleanOptions = Omit<CleanOptions, "excludeRoots" | "ignores"> & GitDirOptions;
export type GitAddOptions = Omit<AddOptions, "excludeRoots"> & GitDirOptions;
export type GitRmOptions = RmOptions & GitDirOptions;
export type GitResetOptions = ResetOptions & GitDirOptions;
export type GitCommitOptions = CommitOptions & GitDirOptions;
export type GitMergeOptions = MergeOptions & GitDirOptions;
export type GitMergeContinueOptions = MergeContinueOptions & GitDirOptions;
export type GitBranchOptions = BranchOptions & GitDirOptions;
export type GitBranchDeleteOptions = BranchDeleteOptions & GitDirOptions;
export type GitTagOptions = TagOptions & GitDirOptions;
export type GitTagDeleteOptions = TagDeleteOptions & GitDirOptions;
export type GitCheckoutOptions = CheckoutOptions & GitDirOptions;
export type GitConfigGetOptions = ConfigGetOptions & GitDirOptions;
export type GitConfigSetOptions = ConfigSetOptions & GitDirOptions;
export type GitRemoteAddOptions = RemoteAddOptions & GitDirOptions;
export type GitRemoteRemoveOptions = RemoteRemoveOptions & GitDirOptions;
export type GitHashObjectOptions = HashObjectOptions & GitDirOptions;
export type GitCatFileOptions = CatFileOptions & GitDirOptions;
export type GitUpdateRefOptions = UpdateRefOptions & GitDirOptions;
export type GitPushOptions = PushOptions & GitDirOptions;
export type GitPullOptions = PullOptions & GitDirOptions;

export interface GitCatFileResult {
  oid: string;
  bytes: Uint8Array;
}

export interface Git {
  clone(input: GitCloneOptions): Promise<void>;
  fetch(input?: GitFetchOptions): Promise<FetchResult>;
  init(input?: GitInitOptions): Promise<void>;
  status(input?: GitDirOptions): Promise<StatusEntry[]>;
  diff(input?: GitDiffOptions): Promise<string>;
  diffSummary(input?: GitDiffOptions): Promise<DiffSummaryEntry[]>;
  clean(input?: GitCleanOptions): Promise<string[]>;
  add(input: GitAddOptions): Promise<void>;
  rm(input: GitRmOptions): Promise<void>;
  reset(input?: GitResetOptions): Promise<void>;
  commit(input: GitCommitOptions): Promise<CommitResult>;
  log(input?: GitDirOptions & { ref?: string; depth?: number }): Promise<CommitView[]>;
  show(input: GitDirOptions & { ref: string }): Promise<CommitView>;
  revParse(input: GitDirOptions & { ref: string }): Promise<string>;
  repoRoot(input?: GitDirOptions): Promise<string>;
  currentBranch(input?: GitDirOptions & CurrentBranchOptions): Promise<string | undefined>;
  lsFiles(input?: GitDirOptions & { ref?: string }): Promise<string[]>;
  lsTree(input: GitDirOptions & { ref: string; path?: string }): Promise<TreeEntryView[]>;
  branch(input: GitBranchOptions): Promise<void>;
  branchDelete(input: GitBranchDeleteOptions): Promise<void>;
  branchList(input?: GitDirOptions): Promise<string[]>;
  tag(input: GitTagOptions): Promise<void>;
  tagDelete(input: GitTagDeleteOptions): Promise<void>;
  tagList(input?: GitDirOptions): Promise<string[]>;
  checkout(input: GitCheckoutOptions): Promise<void>;
  remoteAdd(input: GitRemoteAddOptions): Promise<void>;
  remoteRemove(input: GitRemoteRemoveOptions): Promise<void>;
  remoteList(input?: GitDirOptions): Promise<RemoteView[]>;
  configGet(input: GitConfigGetOptions): Promise<string | string[] | undefined>;
  configSet(input: GitConfigSetOptions): Promise<void>;
  hashObject(input: GitHashObjectOptions): Promise<string>;
  catFile(input: GitCatFileOptions): Promise<GitCatFileResult>;
  updateRef(input: GitUpdateRefOptions): Promise<void>;
  push(input?: GitPushOptions): Promise<PushResult>;
  pull(input?: GitPullOptions): Promise<MergeResult>;
  merge(input: GitMergeOptions): Promise<MergeResult>;
  mergeContinue(input?: GitMergeContinueOptions): Promise<MergeResult>;
  mergeAbort(input?: GitDirOptions): Promise<void>;
  stashPush(input?: GitDirOptions): Promise<never>;
  stashList(input?: GitDirOptions): Promise<never>;
  stashPop(input?: GitDirOptions): Promise<never>;
  cli(input: GitDirOptions & { argv: string[] }): Promise<never>;
}

export interface GitWorkspaceBinding {
  database: SqliteGitDatabase;
  worktree: Worktree;
  initialWorktree?: InitialWorktreeWriter;
  indexTracker?: IndexTrackerWriter;
  sparseWorkspace?: SparseWorkspaceSource;
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

function createGitClient(binding: GitWorkspaceBinding, options: CreateGitOptions): Git {
  const context: GitContext = {
    database: binding.database,
    worktree: binding.worktree,
    now: options.now ?? binding.now,
    timezoneOffset: options.timezoneOffset ?? binding.timezoneOffset,
  };
  if (binding.defaultIdentity !== undefined) context.defaultIdentity = binding.defaultIdentity;
  if (binding.http !== undefined) context.http = binding.http;
  if (binding.initialWorktree !== undefined) context.initialWorktree = binding.initialWorktree;
  if (binding.indexTracker !== undefined) context.indexTracker = binding.indexTracker;
  if (binding.sparseWorkspace !== undefined) context.sparseWorkspace = binding.sparseWorkspace;
  const yieldNow = options.yieldNow ?? binding.yieldNow;
  if (yieldNow !== undefined) context.yieldNow = yieldNow;

  const at = (dir?: string): Repository => openRepository(context, dir ?? "/");
  const excludeRoots = (repo: Repository): string[] => nestedRoots(context, repo.root);

  return {
    async clone(input) {
      await cloneOp(context, input);
    },
    async fetch(input = {}) {
      return fetchInto(context, at(input.dir), input);
    },
    async init(input = {}) {
      initRepository(context, input);
    },
    async status(input = {}) {
      const repo = at(input.dir);
      return eagerStatus(repo, context.worktree, { excludeRoots: excludeRoots(repo) }, context).map(
        (row) => ({
          path: row.path,
          index: row.index,
          worktree: row.worktree,
        }),
      );
    },
    async diff(input = {}) {
      return diffOp(at(input.dir), context.worktree, input, context.sparseWorkspace);
    },
    async diffSummary(input = {}) {
      return diffSummaryOp(at(input.dir), context.worktree, input, context.sparseWorkspace);
    },
    async clean(input = {}) {
      const repo = at(input.dir);
      repo.store.requireNoMergeState();
      return cleanOp(repo, context.worktree, { ...input, excludeRoots: excludeRoots(repo) });
    },
    async add(input) {
      const repo = at(input.dir);
      addOp(repo, context.worktree, { ...input, excludeRoots: excludeRoots(repo) });
    },
    async rm(input) {
      rmOp(at(input.dir), context.worktree, input);
    },
    async reset(input = {}) {
      const repo = at(input.dir);
      if (input.hard === true) {
        repo.store.db.transactionSync(() => {
          resetOp(repo, context.worktree, input);
          repo.store.clearMergeState();
        });
        return;
      }
      repo.store.requireNoMergeState();
      resetOp(repo, context.worktree, input);
    },
    async commit(input) {
      const repo = at(input.dir);
      if (repo.store.readMergeState() !== null) {
        if (input.amend === true) {
          throw new GitError("EINVAL", "cannot amend while continuing a merge");
        }
        const result = mergeContinueOp(context, repo, input);
        if (result.oid === undefined) {
          throw new GitError("ECORRUPT", "merge continuation did not create a commit");
        }
        return { oid: result.oid };
      }
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
    async repoRoot(input = {}) {
      return repoRootOp(context, input);
    },
    async currentBranch(input = {}) {
      return currentBranchOp(at(input.dir), input);
    },
    async lsFiles(input = {}) {
      const repo = at(input.dir);
      return input.ref === undefined ? lsFilesOp(repo) : lsFilesAtRef(repo, input.ref);
    },
    async lsTree(input) {
      return lsTreeOp(at(input.dir), input.ref, input.path);
    },
    async branch(input) {
      const repo = at(input.dir);
      repo.store.requireNoMergeState();
      branchOp(repo, input);
    },
    async branchDelete(input) {
      branchDeleteOp(at(input.dir), input);
    },
    async branchList(input = {}) {
      return branchListOp(at(input.dir));
    },
    async tag(input) {
      tagOp(at(input.dir), input);
    },
    async tagDelete(input) {
      tagDeleteOp(at(input.dir), input);
    },
    async tagList(input = {}) {
      return tagListOp(at(input.dir));
    },
    async checkout(input) {
      const repo = at(input.dir);
      repo.store.requireNoMergeState();
      checkoutOp(context, repo, context.worktree, input);
    },
    async remoteAdd(input) {
      remoteAdd(at(input.dir), input);
    },
    async remoteRemove(input) {
      remoteRemove(at(input.dir), input);
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
    async updateRef(input) {
      const repo = at(input.dir);
      repo.store.requireNoMergeState();
      updateRefOp(repo, input);
    },
    async push(input = {}) {
      return pushOp(context, at(input.dir), input);
    },
    async pull(input = {}) {
      const repo = at(input.dir);
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
    async stashPush() {
      throw new UnsupportedOperationError("stash push");
    },
    async stashList() {
      throw new UnsupportedOperationError("stash list");
    },
    async stashPop() {
      throw new UnsupportedOperationError("stash pop");
    },
    async cli() {
      throw new UnsupportedOperationError("the argv entry point");
    },
  };
}
