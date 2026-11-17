// One-commit revert over the shared replay lifecycle.

import { GitError } from "../../common/errors.js";
import type { GitContext, GitIdentity } from "../core/context.js";
import { requireJournalIdentity } from "../core/journal-input.js";
import type { ReplayResult } from "../core/kinds.js";
import { resolveIdentity } from "../repository/commit.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  cancelReplay,
  continueReplay,
  type ReplayContinueOptions,
  type ReplayPolicy,
  type ReplayStartOptions,
  startReplay,
} from "./replay-lifecycle.js";
import { sourceSubject } from "./replay-planning.js";
import type { ReplayPlan } from "./replay-types.js";

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

// Git reapplies a single revert instead of nesting; deeper chains stay nested.
function revertTitle(subject: string): string {
  const reverted = subject.startsWith('Revert "') ? subject.slice('Revert "'.length) : null;
  return reverted !== null && !reverted.startsWith('Revert "')
    ? `Reapply "${reverted}`
    : `Revert "${subject}"`;
}

function defaultMessage(plan: ReplayPlan): string {
  const title = revertTitle(sourceSubject(plan.sourceCommit.message));
  if (plan.sourceCommit.parent.length > 1) {
    const selectedParent = plan.selectedParentOid;
    if (selectedParent === null) {
      throw new GitError("ECORRUPT", "revert merge plan has no selected parent");
    }
    return `${title}\n\nThis reverts commit ${plan.sourceOid}, reversing\nchanges made to ${selectedParent}.\n`;
  }
  return `${title}\n\nThis reverts commit ${plan.sourceOid}.\n`;
}

const POLICY: ReplayPolicy = {
  kind: "revert",
  incomingLabelStyle: "parent-of-source-subject",
  suspendEmpty: false,
  defaultMessage,
  resolveIdentities: (context, repo, _source, input) => {
    const identities = resolveIdentity(context, repo, {
      author: input.author,
      committer: input.committer,
      env: input.env,
    });
    requireJournalIdentity(identities.author, "author", "revert");
    requireJournalIdentity(identities.committer, "committer", "revert");
    return identities;
  },
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
