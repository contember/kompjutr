// One-commit revert over the shared replay lifecycle.

import type { GitContext, GitIdentity } from "../context.js";
import { GitError } from "../errors.js";
import type { Repository } from "../repository.js";
import type { Worktree } from "../worktree.js";
import { resolveIdentity } from "./commit.js";
import type { ReplayPlan } from "./replay.js";
import {
  cancelReplay,
  continueReplay,
  type ReplayContinueOptions,
  type ReplayPolicy,
  type ReplayResult,
  type ReplayStartOptions,
  startReplay,
} from "./replay-lifecycle.js";

export interface RevertOptions {
  source: string;
  mainline?: number;
  message?: string;
  author?: GitIdentity;
  committer?: GitIdentity;
  env?: Record<string, string>;
}

export interface RevertContinueOptions {
  message?: string;
  author?: GitIdentity;
  committer?: GitIdentity;
  env?: Record<string, string>;
}

function sourceSubject(message: string): string {
  let start = 0;
  while (message.charCodeAt(start) === 0x0a) start++;
  const newline = message.indexOf("\n", start);
  return (newline < 0 ? message.slice(start) : message.slice(start, newline)).replace(/\r$/, "");
}

function defaultMessage(plan: ReplayPlan): string {
  const subject = sourceSubject(plan.sourceCommit.message);
  if (plan.sourceCommit.parent.length > 1) {
    const selectedParent = plan.selectedParentOid;
    if (selectedParent === null) {
      throw new GitError("ECORRUPT", "revert merge plan has no selected parent");
    }
    return `Revert "${subject}"\n\nThis reverts commit ${plan.sourceOid}, reversing\nchanges made to ${selectedParent}.\n`;
  }
  return `Revert "${subject}"\n\nThis reverts commit ${plan.sourceOid}.\n`;
}

const POLICY: ReplayPolicy = {
  kind: "revert",
  incomingLabelStyle: "parent-of-source-subject",
  suspendEmpty: false,
  defaultMessage,
  resolveIdentities: (context, repo, _plan, input) =>
    resolveIdentity(context, repo, {
      author: input.author,
      committer: input.committer,
      env: input.env,
    }),
};

function startInput(options: RevertOptions): ReplayStartOptions {
  return {
    source: options.source,
    mainline: options.mainline,
    message: options.message,
    author: options.author,
    committer: options.committer,
    env: options.env,
  };
}

function continueInput(options: RevertContinueOptions): ReplayContinueOptions {
  return {
    message: options.message,
    author: options.author,
    committer: options.committer,
    env: options.env,
  };
}

export function revert(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RevertOptions,
): ReplayResult {
  return startReplay(context, repo, worktree, startInput(options), POLICY);
}

export function revertContinue(
  context: GitContext,
  repo: Repository,
  options: RevertContinueOptions = {},
): ReplayResult {
  return continueReplay(context, repo, continueInput(options), POLICY);
}

export function revertSkip(repo: Repository, worktree: Worktree): void {
  cancelReplay(repo, worktree, "revert");
}

export function revertAbort(repo: Repository, worktree: Worktree): void {
  cancelReplay(repo, worktree, "revert");
}
