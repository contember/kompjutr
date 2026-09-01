// Internal rebase command family; the native client surface is wired separately.

import type { GitContext } from "./context.js";
import {
  abortRebase,
  abortRebaseExcluding,
  continueRebase,
  continueRebaseExcluding,
  type RebaseContinueOptions,
  type RebaseLifecycleResult,
  type RebaseStartOptions,
  skipRebase,
  skipRebaseExcluding,
  startRebase,
  startRebaseExcluding,
} from "./rebase-lifecycle.js";
import type { Repository } from "./repository.js";
import type { Worktree } from "./worktree.js";

export type { RebaseContinueOptions, RebaseLifecycleResult, RebaseStartOptions };

export function rebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseStartOptions,
): RebaseLifecycleResult {
  return startRebase(context, repo, worktree, options);
}

export function rebaseExcluding(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
  options: RebaseStartOptions,
): RebaseLifecycleResult {
  return startRebaseExcluding(context, repo, worktree, excludeRoots, options);
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

export function rebaseSkipExcluding(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  return skipRebaseExcluding(context, repo, worktree, excludeRoots, options);
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
