import { CorruptError } from "../../common/errors.js";
import type { ProjectedMergeEntry as StoredProjectedEntry } from "../../store/operations/integration-workspace/descriptors.js";
import { withIntegrationWorkspaceOwned } from "../../store/operations/integration-workspace/workspace.js";
import { mergeOperationState } from "../core/operation-state.js";
import { applyIntegrationOwned } from "../integration/integration-apply-owned.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import type {
  ActiveRebaseApply,
  MergeApplyMetadata,
  MergeApplyOutcome,
  MergeApplyResult,
  OperationApplyOptions,
  OperationApplyResult,
  ProjectedRebaseTransitionOptions,
  ProjectedRebaseTransitionResult,
} from "./merge-apply-types.js";
import { validateProjectedIndexEntries } from "./merge-apply-validation.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import { validateMergeStateMetadata } from "./merge-state.js";

function applyDetachedProjection(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: OperationApplyOptions,
  activeRebase: ActiveRebaseApply | null,
): OperationApplyResult {
  validateProjectedIndexEntries(entries);
  return withIntegrationWorkspaceOwned(repo.store, (workspace) => {
    const plan = workspace.projectedPlan();
    function* descriptors(): Generator<StoredProjectedEntry> {
      for (const entry of entries) {
        const content =
          entry.content === null
            ? null
            : {
                oid: workspace.source.write("blob", entry.content),
                size: entry.content.length,
              };
        yield { ...entry, content };
      }
    }
    plan.entries.write(descriptors());
    plan.finish(0, entries.length);
    const result = applyIntegrationOwned(workspace, repo, worktree, plan, options, activeRebase);
    return { touched: result.touched === null ? null : [...result.touched] };
  });
}

export function applyProjectedOperation(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: OperationApplyOptions,
): OperationApplyResult {
  return applyDetachedProjection(repo, worktree, entries, options, null);
}

export function applyProjectedRebaseTransition<T>(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: ProjectedRebaseTransitionOptions<T>,
): ProjectedRebaseTransitionResult<T> {
  return repo.store.db.transactionSync(() => {
    const applied = applyDetachedProjection(
      repo,
      worktree,
      entries,
      { suspendedState: null },
      options,
    );
    if (options.conflictState !== null) {
      if (applied.touched === null)
        throw new CorruptError("conflicted rebase apply omitted its ownership snapshot");
      return { outcome: "conflicted" };
    }
    return { outcome: "clean", value: options.onClean(applied) };
  });
}

export function applyProjectedMerge(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  metadata: MergeApplyMetadata,
): MergeApplyResult {
  const outcome: MergeApplyOutcome = entries.some((entry) => entry.stages !== null)
    ? "conflicted"
    : metadata.mode === "no-commit"
      ? "ready"
      : "clean";
  if (outcome === "clean") validateMergeStateMetadata({ ...metadata, phase: "conflicted" });
  const state = outcome === "clean" ? null : { ...metadata, phase: outcome };
  const applied = applyDetachedProjection(
    repo,
    worktree,
    entries,
    {
      suspendedState: state === null ? null : mergeOperationState(state),
    },
    null,
  );
  return {
    outcome,
    journal:
      state === null || applied.touched === null ? null : { state, touched: applied.touched },
  };
}
