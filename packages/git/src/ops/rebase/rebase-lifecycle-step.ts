import { CorruptError, GitError } from "../../common/errors.js";
import type { Commit } from "../../common/objects.js";
import type { RebaseJournalCursor } from "../../store/index.js";
import {
  type IntegrationWorkspace,
  withIntegrationWorkspaceOwned,
} from "../../store/operations/integration-workspace/workspace.js";
import type { GitContext } from "../core/context.js";
import { requireJournalIdentity } from "../core/journal-input.js";
import { applyIntegrationOwned } from "../integration/integration-apply-owned.js";
import { projectIntegrationStepOwned } from "../integration/integration-step.js";
import { integrationIndexMatchesTree } from "../integration/integration-worktree.js";
import { planFixedReplayStepOwned } from "../replay/replay-planning.js";
import type { ReplayPlan } from "../replay/replay-types.js";
import { resolveIdentity, writeUnpublishedCommit } from "../repository/commit.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  advance,
  requireCurrentBaseline,
  requireOriginalHead,
  requirePathsOutsideExclusions,
  requireRebaseCursor,
  requireRebaseIndex,
  requireRebaseTree,
} from "./rebase-lifecycle-baseline.js";
import type { RebaseContinueOptions, RebaseExclusions } from "./rebase-lifecycle-types.js";

/** The pending step the cursor points at; a completed cursor has none. */
export function requirePendingStep(journal: RebaseJournalCursor) {
  const step = journal.step;
  if (step === null || step.outcome !== "pending") {
    throw new CorruptError("rebase current step is not pending");
  }
  return step;
}

function planCurrentStep(
  workspace: IntegrationWorkspace,
  repo: Repository,
  journal: RebaseJournalCursor,
): ReplayPlan {
  const step = requirePendingStep(journal);
  return planFixedReplayStepOwned(workspace, repo, {
    sourceOid: step.sourceOid,
    selectedParentOid: step.selectedParentOid,
    currentOid: journal.state.currentParentOid,
  });
}

function sourceIsEmpty(plan: ReplayPlan): boolean {
  return plan.sourceTreeOid === plan.selectedParentTreeOid;
}

export function stepIdentities(
  context: GitContext,
  repo: Repository,
  source: Commit,
  options: RebaseContinueOptions,
) {
  const identities = resolveIdentity(
    context,
    repo,
    { committer: options.committer, env: options.env },
    source,
  );
  requireJournalIdentity(identities.committer, "committer", "rebase");
  return identities;
}

export function applyOneStep(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  expectedStep: number,
  options: RebaseContinueOptions,
  exclusions: RebaseExclusions,
): "advanced" | "conflicted" {
  return withIntegrationWorkspaceOwned(repo.store, (workspace) => {
    const journal = requireRebaseCursor(repo);
    if (journal.state.currentStep !== expectedStep) {
      throw new GitError("EOPMISMATCH", "rebase operation changed before replay");
    }
    requireOriginalHead(repo, journal.state);
    if (journal.state.phase !== "running") return "conflicted";
    const currentTree = requireCurrentBaseline(repo, worktree, journal.state, exclusions);
    const plan = planCurrentStep(workspace, repo, journal);
    requireRebaseIndex(repo);
    if (sourceIsEmpty(plan)) {
      const identities = stepIdentities(context, repo, plan.sourceCommit, options);
      const result = writeUnpublishedCommit(repo, {
        message: plan.sourceCommit.message,
        parent: [journal.state.currentParentOid],
        identities,
      });
      advance(repo, journal, "applied", result.oid, identities.committer);
      return "advanced";
    }
    if (plan.integration.entryCount === 0) {
      advance(repo, journal, "skipped", null);
      return "advanced";
    }
    const integration = projectIntegrationStepOwned(workspace, repo, worktree, {
      operation: "rebase",
      baseTreeOid: plan.baseTreeOid,
      incomingTreeOid: plan.incomingTreeOid,
      plan: plan.integration,
      labels: plan.labels,
      baselineTree: currentTree,
      requireProjection: (projected) => {
        for (const entry of projected.entries) {
          requirePathsOutsideExclusions([entry.path, entry.logicalPath], exclusions);
        }
      },
      requireResultTree: (entries) => requireRebaseTree(repo, entries),
    });
    let conflicted = false;
    for (const entry of plan.integration.entries)
      if (entry.kind === "conflict") {
        conflicted = true;
        break;
      }
    applyIntegrationOwned(workspace, repo, worktree, integration, null, {
      currentStep: journal.state.currentStep,
      conflictState: conflicted ? { ...journal.state, phase: "conflicted" } : null,
    });
    if (conflicted) return "conflicted";
    if (integrationIndexMatchesTree(repo, currentTree)) {
      advance(repo, journal, "skipped", null);
      return "advanced";
    }
    const identities = stepIdentities(context, repo, plan.sourceCommit, options);
    const result = writeUnpublishedCommit(repo, {
      message: plan.sourceCommit.message,
      parent: [journal.state.currentParentOid],
      identities,
    });
    advance(repo, journal, "applied", result.oid, identities.committer);
    return "advanced";
  });
}
