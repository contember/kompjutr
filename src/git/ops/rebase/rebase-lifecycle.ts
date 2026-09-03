import { CorruptError, GitError } from "../../common/errors.js";
import { checkoutStoreMutations } from "../../store/checkout/checkout.js";
import { writeOperationJournalOwned } from "../../store/operations/operation-journal.js";
import type { GitContext } from "../core/context.js";
import type { RebaseStateMetadata } from "../core/operation-state.js";
import { operationRefLogMetadata } from "../core/ref-log.js";
import {
  integrationIndexMatchesTree,
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
  preflightBaselineTransition,
  preflightRebaseReplayObjects,
  rebaseExclusions,
  requireCurrentBaseline,
  requireHead,
  requireOriginalHead,
  requireRebaseCursor,
  requireRebaseIndex,
} from "./rebase-lifecycle-baseline.js";
import { driveRebase } from "./rebase-lifecycle-drive.js";
import {
  planCurrentStep,
  requireConflictOwnership,
  stepIdentities,
} from "./rebase-lifecycle-step.js";
import {
  type BaselineTransition,
  NO_REBASE_EXCLUSIONS,
  type RebaseContinueOptions,
  type RebaseExclusions,
  type RebaseLifecycleResult,
  type RebaseStartOptions,
} from "./rebase-lifecycle-types.js";
import { planRebase } from "./rebase-plan.js";

export { preflightRebaseReplayObjects } from "./rebase-lifecycle-baseline.js";
export type {
  RebaseContinueOptions,
  RebaseLifecycleResult,
  RebaseStartOptions,
} from "./rebase-lifecycle-types.js";

export function startRebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseStartOptions,
): RebaseLifecycleResult {
  return startRebaseInternal(context, repo, worktree, options, NO_REBASE_EXCLUSIONS);
}

export function startRebaseExcluding(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
  options: RebaseStartOptions,
): RebaseLifecycleResult {
  return startRebaseInternal(
    context,
    repo,
    worktree,
    options,
    rebaseExclusions(repo, excludeRoots),
  );
}

function startRebaseInternal(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseStartOptions,
  exclusions: RebaseExclusions,
): RebaseLifecycleResult {
  const started = repo.store.db.transactionSync(() => {
    repo.checkout.requireNoOperationState();
    const head = requireHead(repo);
    const originalTree = repo.readCommit(head.oid).tree;
    requireRebaseIndex(repo);
    requireCleanIntegrationIndex(repo, originalTree, "rebase");
    requireCleanIntegrationWorktree(repo, worktree, "rebase", exclusions.absolute);
    const plan = planRebase(repo, { upstream: options.upstream, currentOid: head.oid });
    if (plan.relation === "up-to-date") {
      return { relation: plan.relation, oid: head.oid };
    }
    preflightRebaseReplayObjects(repo, plan);
    const upstreamTree = repo.readCommit(plan.upstreamOid).tree;
    const baseline = preflightBaselineTransition(repo, upstreamTree);
    if (plan.relation === "replay") {
      preflightBaselineTransition(repo, originalTree);
    }
    materializeTree(repo, worktree, originalTree, baseline, exclusions);
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
      context.indexTracker?.advanceBaseline?.(repo.checkout.checkoutId, upstreamTree);
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

type PreparedContinuation = { phase: "running" } | { phase: "conflicted"; currentStep: number };

function prepareContinuation(
  repo: Repository,
  worktree: Worktree,
  exclusions: RebaseExclusions,
): PreparedContinuation {
  const journal = requireRebaseCursor(repo);
  requireOriginalHead(repo, journal.state);
  if (journal.state.phase === "running") {
    requireCurrentBaseline(repo, worktree, journal.state, exclusions);
    return { phase: "running" };
  }
  requireConflictOwnership(repo, worktree, journal);
  return { phase: "conflicted", currentStep: journal.state.currentStep };
}

export function continueRebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  return continueRebaseInternal(context, repo, worktree, options, NO_REBASE_EXCLUSIONS);
}

export function continueRebaseExcluding(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  return continueRebaseInternal(
    context,
    repo,
    worktree,
    options,
    rebaseExclusions(repo, excludeRoots),
  );
}

function continueRebaseInternal(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions,
  exclusions: RebaseExclusions,
): RebaseLifecycleResult {
  const prepared = prepareContinuation(repo, worktree, exclusions);
  if (prepared.phase === "running") {
    return driveRebase(context, repo, worktree, options, exclusions);
  }
  repo.store.db.transactionSync(() => {
    const current = requireRebaseCursor(repo);
    if (
      current.state.phase !== "conflicted" ||
      current.state.currentStep !== prepared.currentStep
    ) {
      throw new GitError("EOPMISMATCH", "rebase conflict changed before continuation");
    }
    requireOriginalHead(repo, current.state);
    if (repo.checkout.hasConflicts()) {
      throw new GitError("EUNMERGED", "cannot continue rebase: the index has unmerged paths");
    }
    requireRebaseIndex(repo);
    requireCleanIntegrationWorktree(repo, worktree, "rebase", exclusions.absolute);
    const plan = planCurrentStep(repo, current);
    const currentTree = repo.readCommit(current.state.currentParentOid).tree;
    const resultEmpty = integrationIndexMatchesTree(repo, currentTree);
    const baseline = resultEmpty ? preflightBaselineTransition(repo, currentTree) : null;
    if (resultEmpty) {
      if (baseline === null) throw new CorruptError("result-empty rebase lost its baseline");
      hardMaterializeTree(repo, worktree, currentTree, baseline, exclusions);
      advance(repo, current, "skipped", null);
    } else {
      const identities = stepIdentities(context, repo, plan, options);
      const result = writeUnpublishedCommit(repo, {
        message: plan.sourceCommit.message,
        parent: [current.state.currentParentOid],
        identities,
      });
      advance(repo, current, "applied", result.oid, identities.committer);
    }
  });
  return driveRebase(context, repo, worktree, options, exclusions);
}

interface PreparedSkip {
  currentStep: number;
  currentTree: string;
  baseline: BaselineTransition;
}

function prepareSkip(repo: Repository, worktree: Worktree): PreparedSkip {
  const journal = requireRebaseCursor(repo);
  requireOriginalHead(repo, journal.state);
  if (journal.state.phase !== "conflicted") {
    throw new GitError("EOPMISMATCH", "rebase skip requires a conflicted step");
  }
  requireConflictOwnership(repo, worktree, journal);
  const currentTree = repo.readCommit(journal.state.currentParentOid).tree;
  return {
    currentStep: journal.state.currentStep,
    currentTree,
    baseline: preflightBaselineTransition(repo, currentTree),
  };
}

export function skipRebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  return skipRebaseInternal(context, repo, worktree, options, NO_REBASE_EXCLUSIONS);
}

export function skipRebaseExcluding(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  return skipRebaseInternal(context, repo, worktree, options, rebaseExclusions(repo, excludeRoots));
}

function skipRebaseInternal(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions,
  exclusions: RebaseExclusions,
): RebaseLifecycleResult {
  const prepared = prepareSkip(repo, worktree);
  repo.store.db.transactionSync(() => {
    const current = requireRebaseCursor(repo);
    if (
      current.state.phase !== "conflicted" ||
      current.state.currentStep !== prepared.currentStep
    ) {
      throw new GitError("EOPMISMATCH", "rebase conflict changed before skip");
    }
    requireOriginalHead(repo, current.state);
    hardMaterializeTree(repo, worktree, prepared.currentTree, prepared.baseline, exclusions);
    advance(repo, current, "skipped", null);
  });
  return driveRebase(context, repo, worktree, options, exclusions);
}

interface PreparedAbort {
  phase: RebaseStateMetadata["phase"];
  currentStep: number;
  baselineTree: string;
  baseline: BaselineTransition;
}

function prepareAbort(repo: Repository, worktree: Worktree): PreparedAbort {
  const journal = requireRebaseCursor(repo);
  requireOriginalHead(repo, journal.state);
  if (journal.state.phase === "conflicted") {
    requireConflictOwnership(repo, worktree, journal);
  }
  const originalTree = repo.readCommit(journal.state.originalHeadOid).tree;
  const baselineTree = repo.readCommit(journal.state.currentParentOid).tree;
  return {
    phase: journal.state.phase,
    currentStep: journal.state.currentStep,
    baselineTree,
    baseline: preflightBaselineTransition(repo, originalTree),
  };
}

export function abortRebase(repo: Repository, worktree: Worktree): void {
  abortRebaseInternal(repo, worktree, NO_REBASE_EXCLUSIONS);
}

export function abortRebaseExcluding(
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
): void {
  abortRebaseInternal(repo, worktree, rebaseExclusions(repo, excludeRoots));
}

function abortRebaseInternal(
  repo: Repository,
  worktree: Worktree,
  exclusions: RebaseExclusions,
): void {
  const prepared = prepareAbort(repo, worktree);
  repo.store.db.transactionSync(() => {
    const current = requireRebaseCursor(repo);
    if (
      current.state.phase !== prepared.phase ||
      current.state.currentStep !== prepared.currentStep
    ) {
      throw new GitError("EOPMISMATCH", "rebase operation changed before abort");
    }
    requireOriginalHead(repo, current.state);
    hardMaterializeTree(repo, worktree, prepared.baselineTree, prepared.baseline, exclusions);
    checkoutStoreMutations(repo.checkout).clearOperationStateOwned();
  });
}
