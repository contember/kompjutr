// Internal rebase command family; the native client surface is wired separately.

import type { GitContext } from "../context.js";
import type { Repository } from "../repository.js";
import type { Worktree } from "../worktree.js";
import {
  abortRebase,
  abortRebaseExcluding,
  continueRebase,
  continueRebaseExcluding,
  type RebaseContinueOptions,
  type RebaseLifecycleResult,
  type RebaseStartOptions,
  skipRebase,
  startRebase,
} from "./rebase-lifecycle.js";

export type { RebaseContinueOptions, RebaseLifecycleResult, RebaseStartOptions };

export function rebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseStartOptions,
): RebaseLifecycleResult {
  return startRebase(context, repo, worktree, options);
}

export function rebaseContinue(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  return continueRebase(context, repo, worktree, options);
}

export function rebaseContinueExcluding(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  return continueRebaseExcluding(context, repo, worktree, excludeRoots, options);
}

export function rebaseSkip(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  return skipRebase(context, repo, worktree, options);
}

export function rebaseAbort(repo: Repository, worktree: Worktree): void {
  abortRebase(repo, worktree);
}

export function rebaseAbortExcluding(
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
): void {
  abortRebaseExcluding(repo, worktree, excludeRoots);
}
