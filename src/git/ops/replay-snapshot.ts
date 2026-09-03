import { CorruptError, GitError, ObjectNotFoundError } from "../common/errors.js";
import { MODE_COMMIT } from "../common/objects.js";
import { comparePaths, joinSorted } from "../common/streams.js";
import { checkoutStoreMutations } from "../store/checkout.js";
import type { IndexEntry, IndexStore } from "../store/index.js";
import { withGitMutationGuard } from "../store/mutation-guard.js";
import { indexFromTree } from "./checkout.js";
import {
  type IntegrationConflictKind,
  type IntegrationPlan,
  MAX_INTEGRATION_SOURCE_ROWS,
} from "./integration.js";
import type { IntegrationStages } from "./integration-structure.js";
import { projectedTouchedShape, requireBoundedIntegrationTree } from "./integration-worktree.js";
import { applyProjectedIndex, validateProjectedIndexEntries } from "./merge-apply.js";
import { type ProjectedMergeEntry, projectMergePlan } from "./merge-projection.js";
import { writeTreeOwned } from "./plumbing.js";
import { planReplay } from "./replay-planning.js";
import {
  readReplayCommit,
  requireBoundedRevision,
  resolveBoundedCommitRevision,
} from "./replay-revision.js";
import type {
  ReplayPlan,
  ReplaySnapshotConflict,
  ReplaySnapshotConflictStage,
  ReplaySnapshotOptions,
  ReplaySnapshotResult,
} from "./replay-types.js";
import type { Repository } from "./repository.js";

export const MAX_SNAPSHOT_REPLAY_SOURCE_ROWS = MAX_INTEGRATION_SOURCE_ROWS;
const SNAPSHOT_OBJECT_INFO_PAGE = 4_096;
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
  plan: IntegrationPlan,
  projected: readonly ProjectedMergeEntry[],
): ReplaySnapshotConflict[] {
  const kinds = new Map<string, IntegrationConflictKind>();
  for (const entry of plan.entries) {
    if (entry.kind === "conflict") kinds.set(entry.path, entry.conflict);
  }
  const conflicts: ReplaySnapshotConflict[] = [];
  for (const entry of projected) {
    if (entry.stages === null) continue;
    const kind = kinds.get(entry.logicalPath);
    if (kind === undefined) {
      throw new CorruptError(`projected conflict ${entry.path} lost its logical conflict kind`);
    }
    conflicts.push({ path: entry.path, kind, stages: conflictStages(entry.stages) });
  }
  return conflicts;
}

function* prospectiveSnapshotIndex(
  repo: Repository,
  currentTreeOid: string,
  projected: readonly ProjectedMergeEntry[],
): Generator<IndexEntry> {
  const owned = projectedTouchedShape(projected);
  let ownedIndex = 0;
  for (const row of joinSorted(indexFromTree(repo, currentTreeOid), projected, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    if (row.right !== undefined) {
      if (row.right.stages !== null) {
        throw new CorruptError("clean snapshot projection retained conflict stages");
      }
      const identity = row.right.stageZero;
      if (identity !== null) {
        yield {
          path: row.right.path,
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
    if (row.left === undefined) continue;
    while (
      owned[ownedIndex] !== undefined &&
      comparePaths(owned[ownedIndex]?.path ?? "", row.left.path) < 0
    ) {
      ownedIndex++;
    }
    if (owned[ownedIndex]?.path !== row.left.path) yield row.left;
  }
}

function validateSnapshotResultObjects(
  repo: Repository,
  currentTreeOid: string,
  projected: readonly ProjectedMergeEntry[],
): void {
  const generated = new Set<string>();
  for (const entry of projected) {
    if (entry.content !== null && entry.stageZero !== null) generated.add(entry.stageZero.oid);
  }
  const required = new Set<string>();
  for (const entry of prospectiveSnapshotIndex(repo, currentTreeOid, projected)) {
    if (entry.mode === 0o160000) {
      throw new GitError("EUNSUPPORTED", `snapshot replay rejects gitlink ${entry.path}`);
    }
    required.add(entry.oid);
  }
  const missing = new Set(repo.store.missing(required));
  for (const oid of missing) {
    if (!generated.has(oid)) throw new ObjectNotFoundError(oid);
  }
  const present = [...required].filter((oid) => !missing.has(oid));
  for (let offset = 0; offset < present.length; offset += SNAPSHOT_OBJECT_INFO_PAGE) {
    for (const object of repo.store.objectInfo(
      present.slice(offset, offset + SNAPSHOT_OBJECT_INFO_PAGE),
    )) {
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
  const plan = planReplay(repo, {
    kind: "cherry-pick",
    source: sourceOid,
    currentOid,
    incomingLabelStyle: "source-subject",
  });
  if (plan.sourceCommit.parent.length !== 1 || plan.selectedParentOid === null) {
    throw new CorruptError("validated snapshot replay source lost its selected parent");
  }
  requireSnapshotTreesWithoutGitlinks(repo, plan);
  const projected = projectMergePlan(plan.integration, {
    currentLabel: plan.labels.current,
    incomingLabel: plan.labels.incoming,
  });
  validateProjectedIndexEntries(projected);
  const conflicts = snapshotConflicts(plan.integration, projected);
  if (conflicts.length > 0) return { outcome: "conflicted", conflicts };

  requireBoundedIntegrationTree(repo, () =>
    prospectiveSnapshotIndex(repo, plan.currentTreeOid, projected),
  );
  validateSnapshotResultObjects(repo, plan.currentTreeOid, projected);
  return repo.store.runScratchAwareOperation(() =>
    repo.store.db.transactionSync(() => {
      if (index === repo.checkout) {
        checkoutStoreMutations(repo.checkout).indexReplaceOwned(
          indexFromTree(repo, plan.currentTreeOid),
        );
      } else {
        index.indexReplace(indexFromTree(repo, plan.currentTreeOid));
      }
      applyProjectedIndex(repo, index, projected);
      return { outcome: "clean", tree: writeTreeOwned(repo, index) };
    }),
  );
}
