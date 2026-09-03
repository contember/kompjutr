import { CorruptError } from "../../common/errors.js";
import { checkoutStoreMutations } from "../../store/checkout/checkout.js";
import type { GitContext } from "../core/context.js";
import type { RebaseStateMetadata } from "../core/operation-state.js";
import { persistedRefLogMetadata } from "../core/ref-log.js";
import type { Repository } from "../repository/repository.js";
import { repositoryMutations } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  requireCurrentBaseline,
  requireOriginalHead,
  requireRebaseCursor,
} from "./rebase-lifecycle-baseline.js";
import { applyOneStep } from "./rebase-lifecycle-step.js";
import type {
  RebaseContinueOptions,
  RebaseExclusions,
  RebaseLifecycleResult,
} from "./rebase-lifecycle-types.js";

function publishCompleted(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  exclusions: RebaseExclusions,
): RebaseLifecycleResult {
  return repo.store.db.transactionSync(() => {
    const journal = requireRebaseCursor(repo);
    requireOriginalHead(repo, journal.state);
    if (journal.state.phase !== "running" || journal.state.currentStep !== journal.stepCount) {
      throw new CorruptError("rebase publication started before replay completion");
    }
    const tree = requireCurrentBaseline(repo, worktree, journal.state, exclusions);
    if (repo.readCommit(journal.state.currentParentOid).tree !== tree) {
      throw new CorruptError("completed rebase baseline changed before publication");
    }
    repositoryMutations(repo).mutateRefsOwned(
      {
        expected: {
          name: journal.state.originalHeadRef,
          target: journal.state.originalHeadOid,
        },
        puts: [
          {
            name: journal.state.originalHeadRef,
            target: journal.state.currentParentOid,
          },
        ],
      },
      persistedRefLogMetadata(context, journal.state.committer, "rebase: replay"),
    );
    // False leaves the old baseline mismatched, so later sparse reads fall back safely.
    context.indexTracker?.advanceBaseline?.(repo.checkout.checkoutId, tree);
    checkoutStoreMutations(repo.checkout).clearOperationStateOwned();
    return {
      outcome: "completed",
      oid: journal.state.currentParentOid,
      replayed: journal.replayed,
      skipped: journal.skipped,
      fastForward: false,
    };
  });
}

interface RebaseDriveState {
  phase: RebaseStateMetadata["phase"];
  currentStep: number;
  stepCount: number;
  replayed: number;
  skipped: number;
}

function readRebaseDriveState(repo: Repository): RebaseDriveState {
  const journal = requireRebaseCursor(repo);
  requireOriginalHead(repo, journal.state);
  return {
    phase: journal.state.phase,
    currentStep: journal.state.currentStep,
    stepCount: journal.stepCount,
    replayed: journal.replayed,
    skipped: journal.skipped,
  };
}

export function driveRebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions,
  exclusions: RebaseExclusions,
): RebaseLifecycleResult {
  for (;;) {
    const state = readRebaseDriveState(repo);
    if (state.phase === "conflicted") {
      return { outcome: "conflicted", replayed: state.replayed, skipped: state.skipped };
    }
    if (state.currentStep === state.stepCount) {
      return publishCompleted(context, repo, worktree, exclusions);
    }
    applyOneStep(context, repo, worktree, state.currentStep, options, exclusions);
  }
}
