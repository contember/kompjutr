import { CorruptError, GitError } from "../../common/errors.js";
import { MODE_COMMIT } from "../../common/objects.js";
import { joinSorted3 } from "../../common/streams.js";
import { checkoutStoreMutations } from "../../store/core/checkout-mutations-registry.js";
import { withGitMutationGuard } from "../../store/core/mutation-guard.js";
import type { IndexEntry, IndexStore } from "../../store/index.js";
import type {
  IntegrationEntry,
  ProjectedMergeEntry,
} from "../../store/operations/integration-workspace/descriptors.js";
import {
  type IntegrationPlanHandle,
  integrationPages,
} from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationTouched } from "../../store/operations/integration-workspace/touched.js";
import {
  type IntegrationWorkspace,
  withIntegrationWorkspaceOwned,
} from "../../store/operations/integration-workspace/workspace.js";
import { indexFromTree } from "../checkout/checkout.js";
import { MAX_INTEGRATION_SOURCE_ROWS } from "../integration/integration.js";
import { adoptProjectedIndex } from "../integration/integration-apply-owned.js";
import type { IntegrationStages } from "../integration/integration-structure.js";
import { integrationTouched } from "../integration/integration-touched.js";
import { requireBoundedIntegrationTree } from "../integration/integration-worktree.js";
import { validateProjectedIndexEntries } from "../merge/merge-apply.js";
import { applyIndex } from "../merge/merge-apply-index.js";
import { projectMergePlanOwned } from "../merge/merge-projection.js";
import { writeTreeOwned } from "../repository/plumbing.js";
import type { Repository } from "../repository/repository.js";
import { planReplayOwned } from "./replay-planning.js";
import {
  readReplayCommit,
  requireBoundedRevision,
  resolveBoundedCommitRevision,
} from "./replay-revision.js";
import type {
  OwnedReplayPlan as ReplayPlan,
  ReplaySnapshotConflict,
  ReplaySnapshotConflictStage,
  ReplaySnapshotOptions,
  ReplaySnapshotResult,
} from "./replay-types.js";

export const MAX_SNAPSHOT_REPLAY_SOURCE_ROWS = MAX_INTEGRATION_SOURCE_ROWS;
function requireSnapshotTreesWithoutGitlinks(repo: Repository, plan: ReplayPlan): void {
  const trees = new Set([plan.selectedParentTreeOid, plan.sourceTreeOid, plan.currentTreeOid]);
  trees.delete(null);
  let rows = 0;
  for (const tree of trees) {
    if (tree === null) continue;
    for (const { path, entry } of repo.walkTree(tree)) {
      if (rows >= MAX_SNAPSHOT_REPLAY_SOURCE_ROWS) {
        throw new GitError(
          "E2BIG",
          `snapshot replay tree scan exceeds ${MAX_SNAPSHOT_REPLAY_SOURCE_ROWS} rows`,
        );
      }
      rows++;
      if (entry.mode === MODE_COMMIT) {
        throw new GitError("EUNSUPPORTED", `snapshot replay rejects gitlink ${path}`);
      }
    }
  }
}

function conflictStages(stagesBySide: IntegrationStages): ReplaySnapshotConflictStage[] {
  const stages: ReplaySnapshotConflictStage[] = [];
  if (stagesBySide.base !== null) {
    stages.push({ stage: 1, mode: stagesBySide.base.mode, oid: stagesBySide.base.oid });
  }
  if (stagesBySide.current !== null) {
    stages.push({ stage: 2, mode: stagesBySide.current.mode, oid: stagesBySide.current.oid });
  }
  if (stagesBySide.incoming !== null) {
    stages.push({ stage: 3, mode: stagesBySide.incoming.mode, oid: stagesBySide.incoming.oid });
  }
  return stages;
}

function snapshotConflicts(
  plan: IntegrationPlanHandle<IntegrationEntry>,
  projected: IntegrationPlanHandle<ProjectedMergeEntry>,
): ReplaySnapshotConflict[] {
  const conflicts: ReplaySnapshotConflict[] = [];
  for (const page of integrationPages(projected.entries)) {
    const logicalEntries = plan.entries.getMany(
      page.filter((entry) => entry.stages !== null).map((entry) => entry.logicalPath),
    );
    for (const entry of page) {
      if (entry.stages === null) continue;
      const logical = logicalEntries.get(entry.logicalPath);
      if (logical === undefined || logical.kind !== "conflict") {
        throw new CorruptError(`projected conflict ${entry.path} lost its logical conflict kind`);
      }
      conflicts.push({
        path: entry.path,
        kind: logical.conflict,
        stages: conflictStages(entry.stages),
      });
    }
  }
  return conflicts;
}

function* prospectiveSnapshotIndex(
  repo: Repository,
  currentTreeOid: string,
  projected: IntegrationPlanHandle<ProjectedMergeEntry>,
  touched: IntegrationTouched,
): Generator<IndexEntry> {
  for (const row of joinSorted3(
    indexFromTree(repo, currentTreeOid),
    projected.entries,
    touched.shapes(),
    {
      a: (entry) => entry.path,
      b: (entry) => entry.path,
      c: (entry) => entry.path,
    },
  )) {
    if (row.b !== undefined) {
      if (row.b.stages !== null) {
        throw new CorruptError("clean snapshot projection retained conflict stages");
      }
      const identity = row.b.stageZero;
      if (identity !== null) {
        yield {
          path: row.b.path,
          stage: 0,
          mode: Number.parseInt(identity.mode, 8),
          oid: identity.oid,
          size: null,
          mtime: null,
          ino: null,
          rev: null,
        };
      }
      continue;
    }
    if (row.a !== undefined && row.c === undefined) yield row.a;
  }
}

function validateSnapshotResultObjects(
  workspace: IntegrationWorkspace,
  repo: Repository,
  currentTreeOid: string,
  projected: IntegrationPlanHandle<ProjectedMergeEntry>,
  touched: IntegrationTouched,
): void {
  for (const page of integrationPages(
    prospectiveSnapshotIndex(repo, currentTreeOid, projected, touched),
  )) {
    const required = new Set<string>();
    for (const entry of page) {
      if (entry.mode === 0o160000) {
        throw new GitError("EUNSUPPORTED", `snapshot replay rejects gitlink ${entry.path}`);
      }
      required.add(entry.oid);
    }
    for (const object of workspace.source.objectInfo([...required])) {
      if (object.type !== "blob") {
        throw new CorruptError(`snapshot replay result ${object.oid} is not a blob`);
      }
    }
  }
}

/** Replay one one-parent snapshot commit into a caller-owned transient index. */
export function replaySnapshot(
  repo: Repository,
  index: IndexStore,
  options: ReplaySnapshotOptions,
): ReplaySnapshotResult {
  return withGitMutationGuard(repo.checkout.db, () => replaySnapshotOwned(repo, index, options));
}

/** @internal Replay a snapshot while the caller owns the Git mutation guard. */
export function replaySnapshotOwned(
  repo: Repository,
  index: IndexStore,
  options: ReplaySnapshotOptions,
): ReplaySnapshotResult {
  return withIntegrationWorkspaceOwned(repo.store, (workspace) =>
    replayInWorkspace(workspace, repo, index, options),
  );
}

function replayInWorkspace(
  workspace: IntegrationWorkspace,
  repo: Repository,
  index: IndexStore,
  options: ReplaySnapshotOptions,
): ReplaySnapshotResult {
  const snapshot = requireBoundedRevision(Reflect.get(options, "snapshot"), {
    input: "snapshot",
    operation: "snapshot replay",
  });
  const onto = requireBoundedRevision(Reflect.get(options, "onto"), {
    input: "onto",
    operation: "snapshot replay",
  });
  const sourceOid = resolveBoundedCommitRevision(repo, snapshot, {
    input: "snapshot",
    operation: "snapshot replay",
  });
  if (readReplayCommit(repo, sourceOid).parent.length !== 1) {
    throw new GitError("EINVAL", "snapshot replay requires exactly one parent");
  }
  const currentOid = repo.peel(repo.revParse(onto));
  const plan = planReplayOwned(workspace, repo, {
    kind: "cherry-pick",
    source: sourceOid,
    currentOid,
    incomingLabelStyle: "source-subject",
  });
  if (plan.sourceCommit.parent.length !== 1 || plan.selectedParentOid === null) {
    throw new CorruptError("validated snapshot replay source lost its selected parent");
  }
  requireSnapshotTreesWithoutGitlinks(repo, plan);
  const projected = projectMergePlanOwned(workspace, plan.integration, {
    currentLabel: plan.labels.current,
    incomingLabel: plan.labels.incoming,
  });
  validateProjectedIndexEntries(projected.entries);
  const conflicts = snapshotConflicts(plan.integration, projected);
  if (conflicts.length > 0) return { outcome: "conflicted", conflicts };

  const touched = integrationTouched(workspace, projected);
  requireBoundedIntegrationTree(repo, () =>
    prospectiveSnapshotIndex(repo, plan.currentTreeOid, projected, touched),
  );
  validateSnapshotResultObjects(workspace, repo, plan.currentTreeOid, projected, touched);
  return repo.store.runScratchAwareOperation(() =>
    repo.store.db.transactionSync(() => {
      if (index === repo.checkout) {
        checkoutStoreMutations(repo.checkout).indexReplaceOwned(
          indexFromTree(repo, plan.currentTreeOid),
        );
      } else {
        index.indexReplace(indexFromTree(repo, plan.currentTreeOid));
      }
      adoptProjectedIndex(workspace, projected);
      applyIndex(index, projected.entries, touched.shapes());
      return { outcome: "clean", tree: writeTreeOwned(repo, index) };
    }),
  );
}
