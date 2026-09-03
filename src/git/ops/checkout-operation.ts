import { GitError } from "../common/errors.js";
import { joinPath } from "../common/paths.js";
import { joinSorted, joinSorted3 } from "../common/streams.js";
import { applyIndexOwned } from "../store/checkout.js";
import type { IndexSink, IndexStore } from "../store/index.js";
import {
  type CheckoutPrunePlan,
  discardUnmergedPaths,
  planEmptyDirectories,
  planWorktreeRemovalBatches,
  pruneEmptyDirectories,
  restoreStructuralConflicts,
} from "./checkout-structure.js";
import {
  boundedCheckoutSourceRows,
  boundedCheckoutWorktreeEntries,
  CHECKOUT_PATH_FIXED_BYTES,
  CHECKOUT_REMOVAL_BYTES,
  CHECKOUT_WINDOW_ROWS,
  type CheckoutCandidate,
  checkoutWriteBudget,
  flushCheckoutCandidates,
  intersectsExcluded,
  matchesPaths,
  stageZero,
} from "./checkout-support.js";
import type { CheckoutInternalOptions } from "./checkout-types.js";
import { flushCheckoutWrites } from "./checkout-writes.js";
import type { Repository } from "./repository.js";
import type { TargetEntry } from "./tree-stream.js";
import type { Worktree } from "./worktree.js";
import { walkWorktreeEntriesStream } from "./worktree-io.js";

function requireExcludedIndexIdentity(
  target: () => Iterable<TargetEntry>,
  index: IndexStore,
  excludeRoots: readonly string[],
  maxSourceRows: number | undefined,
): void {
  if (excludeRoots.length === 0) return;
  for (const row of joinSorted(
    boundedCheckoutSourceRows(target(), maxSourceRows, "tree"),
    boundedCheckoutSourceRows(index.indexScan(), maxSourceRows, "index"),
    {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    },
  )) {
    if (!intersectsExcluded(row.path, excludeRoots)) continue;
    if (
      row.left === undefined ||
      row.right === undefined ||
      row.right.stage !== 0 ||
      row.right.oid !== row.left.oid ||
      row.right.mode !== Number.parseInt(row.left.mode, 8)
    ) {
      throw new GitError(
        "ECHECKOUTFAIL",
        `checkout target changes foreign checkout path ${row.path}`,
      );
    }
  }
}

export function checkoutTreeInternal(
  repo: Repository,
  worktree: Worktree,
  target: () => Iterable<TargetEntry>,
  options: CheckoutInternalOptions,
  index: IndexStore,
): void {
  requireExcludedIndexIdentity(
    target,
    index,
    options.relativeExcludeRoots,
    options.maxSourceRowsPerPass,
  );
  const writeBudget = checkoutWriteBudget(options.maxWriteBytes);
  if (options.discardUnmerged === true) {
    discardUnmergedPaths(
      repo,
      worktree,
      options.maxWorktreeRowsPerPass,
      options.maxSourceRowsPerPass,
      index,
      options.excludeRoots,
    );
  }
  const preservedRemovals =
    options.restoreStructure === true
      ? restoreStructuralConflicts(repo, worktree, target, options, index)
      : new Set<string>();
  const removed: string[] = [];
  let prunePlan: CheckoutPrunePlan | undefined;

  // Remove obsolete paths before writing replacements. This also handles a
  // directory-to-file transition without retaining the whole target tree.
  applyIndexOwned(index, (sink) => {
    let retainedBytes = 0;
    for (const row of joinSorted(
      boundedCheckoutSourceRows(target(), options.maxSourceRowsPerPass, "tree"),
      stageZero(
        boundedCheckoutSourceRows(index.indexScan(), options.maxSourceRowsPerPass, "index"),
      ),
      {
        left: (entry) => entry.path,
        right: (entry) => entry.path,
      },
    )) {
      const entry = row.left;
      const existing = row.right;
      if (intersectsExcluded(row.path, options.relativeExcludeRoots)) continue;
      if (entry !== undefined || existing === undefined || options.prune === false) continue;
      if (!matchesPaths(existing.path, options.paths)) continue;
      retainedBytes += CHECKOUT_PATH_FIXED_BYTES + existing.path.length * 2;
      if (retainedBytes > CHECKOUT_REMOVAL_BYTES) {
        throw new GitError(
          "E2BIG",
          `checkout removal state exceeds ${CHECKOUT_REMOVAL_BYTES} bytes`,
        );
      }
      removed.push(existing.path);
    }
    if (removed.length > 0) {
      prunePlan = planEmptyDirectories(
        repo,
        worktree,
        removed,
        preservedRemovals,
        options.maxWorktreeRowsPerPass,
        options.excludeRoots,
        options.relativeExcludeRoots,
      );
    }
    flushRemovals(repo, worktree, removed, preservedRemovals, sink);
  });
  if (prunePlan !== undefined) pruneEmptyDirectories(repo, worktree, prunePlan);

  const written: TargetEntry[] = [];
  const candidates: CheckoutCandidate[] = [];
  applyIndexOwned(index, (sink) => {
    for (const row of joinSorted3(
      boundedCheckoutSourceRows(target(), options.maxSourceRowsPerPass, "tree"),
      stageZero(
        boundedCheckoutSourceRows(index.indexScan(), options.maxSourceRowsPerPass, "index"),
      ),
      boundedCheckoutWorktreeEntries(
        walkWorktreeEntriesStream(worktree, repo.root, {
          excludeRoots: options.excludeRoots,
          includeIgnored: true,
          maxScanRows: options.maxWorktreeRowsPerPass,
        }),
        options.maxWorktreeRowsPerPass,
      ),
      { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
    )) {
      const entry = row.a;
      if (entry === undefined || !matchesPaths(entry.path, options.paths)) continue;
      if (intersectsExcluded(entry.path, options.relativeExcludeRoots)) continue;
      if (entry.mode === "160000") continue; // submodules are out of scope
      if (
        options.preserveMatchingIndex === true &&
        row.b !== undefined &&
        row.b.oid === entry.oid &&
        row.b.mode === Number.parseInt(entry.mode, 8)
      ) {
        continue;
      }
      candidates.push({ entry, index: row.b, worktree: row.c });
      if (candidates.length >= CHECKOUT_WINDOW_ROWS) {
        flushCheckoutCandidates(repo, worktree, candidates, written, sink, writeBudget);
      }
    }
    flushCheckoutCandidates(repo, worktree, candidates, written, sink, writeBudget);
    flushCheckoutWrites(repo, worktree, written, sink, writeBudget);
  });
}

function flushRemovals(
  repo: Repository,
  worktree: Worktree,
  removed: string[],
  preserved: ReadonlySet<string>,
  sink: IndexSink,
): void {
  if (removed.length === 0) return;
  const physical = removed.filter((path) => !preserved.has(path));
  for (const batch of planWorktreeRemovalBatches(repo, physical)) {
    worktree.removeFiles(batch.map((path) => joinPath(repo.root, path)));
  }
  for (let offset = 0; offset < removed.length; offset += CHECKOUT_WINDOW_ROWS) {
    for (const path of removed.slice(offset, offset + CHECKOUT_WINDOW_ROWS)) sink.remove(path);
    sink.flush();
  }
}
