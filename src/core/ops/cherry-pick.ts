// One-commit cherry-pick over the shared replay lifecycle.

import type { GitContext, GitIdentity } from "../context.js";
import type { Repository } from "../repository.js";
import type { Worktree } from "../worktree.js";
import { resolveIdentity } from "./commit.js";
import {
  cancelReplay,
  continueReplay,
  type ReplayContinueOptions,
  type ReplayPolicy,
  type ReplayResult,
  type ReplayStartOptions,
  startReplay,
} from "./replay-lifecycle.js";

export interface CherryPickOptions {
  source: string;
  mainline?: number;
  message?: string;
  committer?: GitIdentity;
  env?: Record<string, string>;
}

export interface CherryPickContinueOptions {
  message?: string;
  committer?: GitIdentity;
  env?: Record<string, string>;
}

const POLICY: ReplayPolicy = {
  kind: "cherry-pick",
  incomingLabelStyle: "source-subject",
  suspendEmpty: true,
  defaultMessage: (plan) => plan.sourceCommit.message,
  resolveIdentities: (context, repo, plan, input) =>
    resolveIdentity(
      context,
      repo,
      { committer: input.committer, env: input.env },
      plan.sourceCommit,
    ),
};

function startInput(options: CherryPickOptions): ReplayStartOptions {
  return {
    source: options.source,
    mainline: options.mainline,
    message: options.message,
    committer: options.committer,
    env: options.env,
  };
}

function continueInput(options: CherryPickContinueOptions): ReplayContinueOptions {
  return { message: options.message, committer: options.committer, env: options.env };
}

export function cherryPick(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: CherryPickOptions,
): ReplayResult {
  return startReplay(context, repo, worktree, startInput(options), POLICY);
}

export function cherryPickContinue(
  context: GitContext,
  repo: Repository,
  options: CherryPickContinueOptions = {},
): ReplayResult {
  return continueReplay(context, repo, continueInput(options), POLICY);
}

export function cherryPickSkip(repo: Repository, worktree: Worktree): void {
  cancelReplay(repo, worktree, "cherry-pick");
}

export function cherryPickAbort(repo: Repository, worktree: Worktree): void {
  cancelReplay(repo, worktree, "cherry-pick");
}
