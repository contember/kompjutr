// Rebase lifecycle entry points. Each validates and mutates in one transaction,
// then `driveRebase` replays the remaining steps one transaction per step.

import { GitError } from "../../common/errors.js";
import { checkoutStoreMutations } from "../../store/core/checkout-mutations-registry.js";
import { writeOperationJournalOwned } from "../../store/operations/operation-journal.js";
import type { GitContext } from "../core/context.js";
import { requireJournalIdentity } from "../core/journal-input.js";
import { requireSharedMutationScope } from "../core/mutation-scope.js";
import { operationRefLogMetadata } from "../core/ref-log.js";
import {
  integrationIndexMatchesTree,
  requireBoundedIntegrationIndex,
  requireCleanIntegrationIndex,
  requireCleanIntegrationWorktree,
} from "../integration/integration-worktree.js";
import { writeUnpublishedCommit } from "../repository/commit.js";
import type { Repository } from "../repository/repository.js";
import { repositoryMutations } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  advance,
  hardMaterializeTree,
  initialState,
  materializeTree,
  preflightBaselineTree,
  preflightRebaseReplayObjects,
  rebaseExclusions,
  requireCurrentBaseline,
  requireHead,
  requireOriginalHead,
  requireRebaseCursor,
} from "./rebase-lifecycle-baseline.js";
import { driveRebase } from "./rebase-lifecycle-drive.js";
import { requirePendingStep, stepIdentities } from "./rebase-lifecycle-step.js";
import type {
  RebaseContinueOptions,
  RebaseLifecycleResult,
  RebaseStartOptions,
} from "./rebase-lifecycle-types.js";
import { planRebase } from "./rebase-plan.js";

export type {
  RebaseContinueOptions,
  RebaseLifecycleResult,
  RebaseStartOptions,
} from "./rebase-lifecycle-types.js";

/** `excludeRoots` are absolute roots of nested checkouts that the rebase must not touch. */
export function rebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
  options: RebaseStartOptions,
): RebaseLifecycleResult {
  requireJournalIdentity(options.committer, "committer", "rebase");
  const exclusions = rebaseExclusions(repo, excludeRoots);
  requireSharedMutationScope(repo.store.db, worktree);
  const started = repo.store.db.transactionSync(() => {
    repo.checkout.requireNoOperationState();
    const head = requireHead(repo);
    const originalTree = repo.readCommit(head.oid).tree;
    requireBoundedIntegrationIndex(repo);
    requireCleanIntegrationIndex(repo, originalTree, "rebase");
    requireCleanIntegrationWorktree(repo, worktree, "rebase", exclusions.absolute);
    const plan = planRebase(repo, { upstream: options.upstream, currentOid: head.oid });
    if (plan.relation === "up-to-date") {
      return { relation: plan.relation, oid: head.oid };
    }
    preflightRebaseReplayObjects(repo, plan);
    const upstreamTree = repo.readCommit(plan.upstreamOid).tree;
    preflightBaselineTree(repo, upstreamTree);
    if (plan.relation === "replay") {
      preflightBaselineTree(repo, originalTree);
    }
    materializeTree(repo, worktree, originalTree, upstreamTree, exclusions);
    const observed = repo.head();
    if (observed.ref !== head.ref || observed.oid !== head.oid) {
      throw new GitError("ESTALEHEAD", "HEAD changed while rebase was being prepared");
    }
    if (plan.relation === "fast-forward") {
      repositoryMutations(repo).mutateRefsOwned(
        {
          expected: { name: head.ref, target: head.oid },
          puts: [{ name: head.ref, target: plan.upstreamOid }],
        },
        operationRefLogMetadata(context, repo, "rebase: fast-forward", {
          identity: options.committer,
          env: options.env,
        }),
      );
      // False leaves the old baseline mismatched, so later sparse reads fall back safely.
      context.indexTracker?.advanceBaseline(repo.checkout.checkoutId, upstreamTree);
      return { relation: plan.relation, oid: plan.upstreamOid };
    }
    const actor = operationRefLogMetadata(context, repo, "rebase: replay", {
      identity: options.committer,
      env: options.env,
    }).actor;
    const state = initialState(head, plan.upstreamOid, plan.baseOid, actor);
    writeOperationJournalOwned(repo.checkout, state, plan.steps, []);
    return { relation: plan.relation, oid: plan.upstreamOid };
  });
  if (started.relation === "up-to-date") return { outcome: "up-to-date", oid: started.oid };
  if (started.relation === "fast-forward") {
    return {
      outcome: "completed",
      oid: started.oid,
      replayed: 0,
      skipped: 0,
      fastForward: true,
    };
  }
  return driveRebase(context, repo, worktree, options, exclusions);
}

export function rebaseContinue(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  const exclusions = rebaseExclusions(repo, excludeRoots);
  requireSharedMutationScope(repo.store.db, worktree);
  repo.store.db.transactionSync(() => {
    const journal = requireRebaseCursor(repo);
    requireOriginalHead(repo, journal.state);
    if (journal.state.phase === "running") {
      requireCurrentBaseline(repo, worktree, journal.state, exclusions);
      return;
    }
    const step = requirePendingStep(journal);
    if (repo.checkout.hasConflicts()) {
      throw new GitError("EUNMERGED", "cannot continue rebase: the index has unmerged paths");
    }
    requireBoundedIntegrationIndex(repo);
    requireCleanIntegrationWorktree(repo, worktree, "rebase", exclusions.absolute);
    const currentTree = repo.readCommit(journal.state.currentParentOid).tree;
    if (integrationIndexMatchesTree(repo, currentTree)) {
      preflightBaselineTree(repo, currentTree);
      hardMaterializeTree(repo, worktree, currentTree, currentTree, exclusions);
      advance(repo, journal, "skipped", null);
      return;
    }
    const source = repo.readCommit(step.sourceOid);
    const identities = stepIdentities(context, repo, source, options);
    const result = writeUnpublishedCommit(repo, {
      message: source.message,
      parent: [journal.state.currentParentOid],
      identities,
    });
    advance(repo, journal, "applied", result.oid, identities.committer);
  });
  return driveRebase(context, repo, worktree, options, exclusions);
}

export function rebaseSkip(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  const exclusions = rebaseExclusions(repo, excludeRoots);
  requireSharedMutationScope(repo.store.db, worktree);
  repo.store.db.transactionSync(() => {
    const journal = requireRebaseCursor(repo);
    requireOriginalHead(repo, journal.state);
    if (journal.state.phase !== "conflicted") {
      throw new GitError("EOPMISMATCH", "rebase skip requires a conflicted step");
    }
    const currentTree = repo.readCommit(journal.state.currentParentOid).tree;
    preflightBaselineTree(repo, currentTree);
    hardMaterializeTree(repo, worktree, currentTree, currentTree, exclusions);
    advance(repo, journal, "skipped", null);
  });
  return driveRebase(context, repo, worktree, options, exclusions);
}

export function rebaseAbort(
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
): void {
  const exclusions = rebaseExclusions(repo, excludeRoots);
  requireSharedMutationScope(repo.store.db, worktree);
  repo.store.db.transactionSync(() => {
    const journal = requireRebaseCursor(repo);
    requireOriginalHead(repo, journal.state);
    const originalTree = repo.readCommit(journal.state.originalHeadOid).tree;
    const baselineTree = repo.readCommit(journal.state.currentParentOid).tree;
    preflightBaselineTree(repo, originalTree);
    hardMaterializeTree(repo, worktree, baselineTree, originalTree, exclusions);
    checkoutStoreMutations(repo.checkout).clearOperationStateOwned();
  });
}
