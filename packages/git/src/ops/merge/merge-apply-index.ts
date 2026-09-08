import { GitError } from "../../common/errors.js";
import { MODE_COMMIT } from "../../common/objects.js";
import { comparePaths } from "../../common/streams.js";
import { applyIndexOwned } from "../../store/checkout/checkout.js";
import type { IndexEntry, IndexSink, IndexStore } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import type { WorktreeStat } from "../worktree/worktree.js";
import { contentObjects } from "./merge-apply-blobs.js";
import type { OwnedPaths, TouchedSpec } from "./merge-apply-types.js";
import {
  requireIdentity,
  touchedSpecs,
  validateProjectedIndexEntries,
} from "./merge-apply-validation.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import type { MergeTouchedPath } from "./merge-state.js";

function putIdentity(
  sink: IndexSink,
  path: string,
  stage: number,
  mode: string,
  oid: string,
): void {
  sink.put({
    path,
    stage,
    mode: requireIdentity(mode, oid, path),
    oid,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  });
}

export function applyIndex(
  index: IndexStore,
  entries: readonly ProjectedMergeEntry[],
  specs: readonly TouchedSpec[],
): void {
  const projected = new Set<string>();
  for (const entry of entries) projected.add(entry.path);
  applyIndexOwned(index, (sink) => {
    for (const spec of specs) {
      if (!projected.has(spec.path)) sink.remove(spec.path);
    }
    for (const entry of entries) {
      sink.remove(entry.path);
      if (entry.stageZero !== null) {
        putIdentity(sink, entry.path, 0, entry.stageZero.mode, entry.stageZero.oid);
      }
      if (entry.stages !== null) {
        if (entry.stages.base !== null) {
          putIdentity(sink, entry.path, 1, entry.stages.base.mode, entry.stages.base.oid);
        }
        if (entry.stages.current !== null) {
          putIdentity(sink, entry.path, 2, entry.stages.current.mode, entry.stages.current.oid);
        }
        if (entry.stages.incoming !== null) {
          putIdentity(sink, entry.path, 3, entry.stages.incoming.mode, entry.stages.incoming.oid);
        }
      }
    }
  });
}

/** Write a validated clean projection to one caller-selected index. */
export function applyProjectedIndex(
  repo: Repository,
  index: IndexStore,
  entries: readonly ProjectedMergeEntry[],
): void {
  validateProjectedIndexEntries(entries);
  if (entries.some((entry) => entry.stages !== null)) {
    throw new GitError("EUNMERGED", "cannot apply a conflicted projection to an index");
  }
  const specs = touchedSpecs(entries);
  repo.store.runScratchAwareOperation(() =>
    repo.store.db.transactionSync(() => {
      contentObjects(repo, entries);
      applyIndex(index, entries, specs.entries);
    }),
  );
}

export function applyDestructiveRoots(entries: readonly ProjectedMergeEntry[]): OwnedPaths {
  const roots: string[] = [];
  for (const entry of entries) {
    if (entry.worktree === null || entry.worktree.mode !== MODE_COMMIT) roots.push(entry.path);
  }
  roots.sort(comparePaths);
  return { entries: roots };
}

export function structuralRemovals(
  entries: readonly ProjectedMergeEntry[],
  snapshots: ReadonlyMap<string, WorktreeStat>,
): OwnedPaths {
  const removals = new Set<string>();
  const add = (path: string): void => {
    if (removals.has(path)) return;
    removals.add(path);
  };
  for (const entry of entries) {
    if (entry.worktree === null || snapshots.get(entry.path)?.type === "dir") {
      add(entry.path);
    }
    if (entry.worktree === null) continue;
    let slash = entry.path.lastIndexOf("/");
    while (slash > 0) {
      const ancestor = entry.path.slice(0, slash);
      const stat = snapshots.get(ancestor);
      if (stat !== undefined && stat.type !== "dir") {
        add(ancestor);
      }
      slash = ancestor.lastIndexOf("/");
    }
  }
  const paths = [...removals].sort(comparePaths);
  return { entries: paths };
}
export function abortDestructiveRoots(touched: readonly MergeTouchedPath[]): OwnedPaths {
  const roots: string[] = [];
  for (const entry of touched) {
    if (entry.worktree.kind !== "directory") roots.push(entry.path);
  }
  roots.sort(comparePaths);
  return { entries: roots };
}

export function restoreIndex(repo: Repository, touched: readonly MergeTouchedPath[]): void {
  applyIndexOwned(repo.checkout, (sink) => {
    for (const entry of touched) {
      sink.remove(entry.path);
      if (entry.index !== null) {
        const restored: IndexEntry = { path: entry.path, ...entry.index };
        sink.put(restored);
      }
    }
  });
}
