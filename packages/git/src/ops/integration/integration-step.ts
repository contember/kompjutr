import type { IndexEntry } from "../../store/index.js";
import type {
  IntegrationEntry,
  ProjectedMergeEntry,
} from "../../store/operations/integration-workspace/descriptors.js";
import type { IntegrationPlanHandle } from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationTouched } from "../../store/operations/integration-workspace/touched.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { projectIntegrationWithCollisionsOwned } from "./integration-collisions-owned.js";
import { integrationTouched } from "./integration-touched.js";
import {
  type IntegrationOperation,
  prospectiveIntegrationIndexEntriesOwned,
  requireSafeIntegrationWorktreeOwned,
} from "./integration-worktree.js";

export interface IntegrationStep {
  operation: IntegrationOperation;
  baseTreeOid: string | null;
  incomingTreeOid: string | null;
  plan: IntegrationPlanHandle<IntegrationEntry>;
  labels: { current: string; incoming: string };
  /** The checked-out tree when it is not HEAD's, as during a rebase. */
  baselineTree?: string;
  requireProjection?: (projected: IntegrationPlanHandle<ProjectedMergeEntry>) => void;
  /** Omitted when the result is an existing commit's tree, as in a fast-forward. */
  requireResultTree?: (entries: Iterable<IndexEntry>) => void;
}

export interface ProjectedIntegration {
  projected: IntegrationPlanHandle<ProjectedMergeEntry>;
  touched: IntegrationTouched;
}

/** Project a planned integration and refuse it before `applyIntegrationOwned` changes anything. */
export function projectIntegrationStepOwned(
  workspace: IntegrationWorkspace,
  repo: Repository,
  worktree: Worktree,
  step: IntegrationStep,
): ProjectedIntegration {
  const projected = projectIntegrationWithCollisionsOwned(
    workspace,
    repo,
    worktree,
    step.baseTreeOid,
    step.incomingTreeOid,
    step.plan,
    step.labels.current,
    step.labels.incoming,
    undefined,
    step.operation,
  );
  step.requireProjection?.(projected);
  requireSafeIntegrationWorktreeOwned(
    repo,
    worktree,
    step.incomingTreeOid,
    step.plan,
    step.operation,
    step.baselineTree,
  );
  const touched = integrationTouched(workspace, projected);
  step.requireResultTree?.(prospectiveIntegrationIndexEntriesOwned(repo, projected, touched));
  return { projected, touched };
}
