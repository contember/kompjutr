import { CorruptError, GitError } from "../../common/errors.js";
import { joinSorted } from "../../common/streams.js";
import type { RebaseJournalCursor } from "../../store/index.js";
import {
  type IntegrationWorkspace,
  withIntegrationWorkspaceOwned,
} from "../../store/operations/integration-workspace/workspace.js";
import type { GitContext } from "../core/context.js";
import { applyIntegrationOwned } from "../integration/integration-apply-owned.js";
import { projectIntegrationWithCollisionsOwned } from "../integration/integration-collisions-owned.js";
import { integrationTouched } from "../integration/integration-touched.js";
import {
  integrationIndexMatchesTree,
  prospectiveIntegrationIndexEntriesOwned,
  requireSafeIntegrationWorktreeOwned,
} from "../integration/integration-worktree.js";
import { planFixedReplayStepOwned } from "../replay/replay-planning.js";
import type { ReplayPlan } from "../replay/replay-types.js";
import { resolveIdentity, writeUnpublishedCommit } from "../repository/commit.js";
import type { Repository } from "../repository/repository.js";
import { treeStream } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  advance,
  requireCurrentBaseline,
  requireOriginalHead,
  requirePathsOutsideExclusions,
  requireRebaseCursor,
  requireRebaseIndex,
  requireRebaseTree,
  sameQueueStep,
} from "./rebase-lifecycle-baseline.js";
import type { RebaseContinueOptions, RebaseExclusions } from "./rebase-lifecycle-types.js";

export function planCurrentStep(
  workspace: IntegrationWorkspace,
  repo: Repository,
  journal: RebaseJournalCursor,
): ReplayPlan {
  const step = journal.step;
  if (step === null || step.outcome !== "pending") {
    throw new CorruptError("rebase current step is not pending");
  }
  const plan = planFixedReplayStepOwned(workspace, repo, {
    sourceOid: step.sourceOid,
    selectedParentOid: step.selectedParentOid,
    currentOid: journal.state.currentParentOid,
  });
  if (
    !sameQueueStep(step, {
      sourceOid: plan.sourceOid,
      selectedParentOid: plan.selectedParentOid,
      mainline: plan.mainline,
      outcome: "pending",
      resultOid: null,
    })
  ) {
    throw new CorruptError("rebase replay plan differs from its current journal step");
  }
  return plan;
}

function sourceIsEmpty(plan: ReplayPlan): boolean {
  return plan.sourceTreeOid === plan.selectedParentTreeOid;
}

export function stepIdentities(
  context: GitContext,
  repo: Repository,
  plan: ReplayPlan,
  options: RebaseContinueOptions,
) {
  return resolveIdentity(
    context,
    repo,
    { committer: options.committer, env: options.env },
    plan.sourceCommit,
  );
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
      const identities = stepIdentities(context, repo, plan, options);
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
    const projected = projectIntegrationWithCollisionsOwned(
      workspace,
      repo,
      worktree,
      plan.baseTreeOid,
      plan.incomingTreeOid,
      plan.integration,
      plan.labels.current,
      plan.labels.incoming,
      undefined,
      "rebase",
    );
    for (const entry of projected.entries) {
      requirePathsOutsideExclusions([entry.path, entry.logicalPath], exclusions);
    }
    requireSafeIntegrationWorktreeOwned(
      repo,
      worktree,
      plan.incomingTreeOid,
      plan.integration,
      "rebase",
      currentTree,
    );
    const touched = integrationTouched(workspace, projected);
    requireRebaseTree(repo, () =>
      prospectiveIntegrationIndexEntriesOwned(repo, projected, touched),
    );
    let conflicted = false;
    for (const entry of plan.integration.entries)
      if (entry.kind === "conflict") {
        conflicted = true;
        break;
      }
    applyIntegrationOwned(
      workspace,
      repo,
      worktree,
      projected,
      { suspendedState: null },
      {
        currentStep: journal.state.currentStep,
        conflictState: conflicted ? { ...journal.state, phase: "conflicted" } : null,
      },
    );
    if (conflicted) return "conflicted";
    if (integrationIndexMatchesTree(repo, currentTree)) {
      advance(repo, journal, "skipped", null);
      return "advanced";
    }
    const identities = stepIdentities(context, repo, plan, options);
    const result = writeUnpublishedCommit(repo, {
      message: plan.sourceCommit.message,
      parent: [journal.state.currentParentOid],
      identities,
    });
    advance(repo, journal, "applied", result.oid, identities.committer);
    return "advanced";
  });
}

export function requireConflictOwnership(
  repo: Repository,
  worktree: Worktree,
  journal: RebaseJournalCursor,
): void {
  withIntegrationWorkspaceOwned(repo.store, (workspace) =>
    validateConflictOwnership(workspace, repo, worktree, journal),
  );
}

function validateConflictOwnership(
  workspace: IntegrationWorkspace,
  repo: Repository,
  worktree: Worktree,
  journal: RebaseJournalCursor,
): void {
  requireConflictSnapshots(repo, journal);
  const plan = planCurrentStep(workspace, repo, journal);
  const omitted = workspace.touched(plan.integration);
  omitted.reserve(journal.touched);
  const projected = projectIntegrationWithCollisionsOwned(
    workspace,
    repo,
    worktree,
    plan.baseTreeOid,
    plan.incomingTreeOid,
    plan.integration,
    plan.labels.current,
    plan.labels.incoming,
    omitted,
    "rebase",
  );
  const expected = integrationTouched(workspace, projected);
  if (expected.length !== journal.touched.length) {
    throw new CorruptError("rebase conflict ownership is incomplete");
  }
  for (const row of joinSorted(expected.shapes(), journal.touched, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const left = row.left;
    const right = row.right;
    if (
      left === undefined ||
      right === undefined ||
      left.path !== right.path ||
      left.logicalPath !== right.logicalPath ||
      left.purpose !== right.purpose
    ) {
      throw new CorruptError("rebase conflict ownership differs from its replay plan");
    }
  }
}

function requireConflictSnapshots(repo: Repository, journal: RebaseJournalCursor): void {
  const currentTree = repo.readCommit(journal.state.currentParentOid).tree;
  for (const row of joinSorted(treeStream(repo, currentTree), journal.touched, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const saved = row.right;
    if (saved === undefined) continue;
    const expected = row.left;
    if (expected === undefined) {
      if (
        saved.index !== null ||
        (saved.worktree.kind !== "absent" && saved.worktree.kind !== "directory")
      ) {
        throw new CorruptError(`rebase snapshot differs from its current parent at ${saved.path}`);
      }
      continue;
    }
    if (
      saved.index === null ||
      saved.index.stage !== 0 ||
      saved.index.oid !== expected.oid ||
      saved.index.mode !== Number.parseInt(expected.mode, 8)
    ) {
      throw new CorruptError(`rebase index snapshot differs at ${saved.path}`);
    }
    const worktree = saved.worktree;
    if (worktree.kind !== "file" && worktree.kind !== "symlink") {
      throw new CorruptError(`rebase worktree snapshot differs at ${saved.path}`);
    }
    const mode =
      worktree.kind === "symlink" ? "120000" : (worktree.mode & 0o111) === 0 ? "100644" : "100755";
    if (worktree.oid !== expected.oid || mode !== expected.mode) {
      throw new CorruptError(`rebase worktree snapshot differs at ${saved.path}`);
    }
  }
}
