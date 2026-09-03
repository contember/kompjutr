import { CorruptError } from "../common/errors.js";
import { contentIdKey } from "../store/index.js";
import type { Repository } from "./repository.js";
import type { SparseCheckoutCandidate } from "./sparse-checkout-operation.js";
import type { SparseWorkspaceRow } from "./sparse-workspace.js";
import type { TargetEntry } from "./tree-stream.js";
import { gitModeFor, type Worktree } from "./worktree.js";
import { hashExactWorktreePathsOwned, indexMatchesStat, type WorktreePath } from "./worktree-io.js";

export function validateSparseCheckoutRows(
  candidates: readonly SparseCheckoutCandidate[],
  rows: readonly SparseWorkspaceRow[],
): boolean {
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const row = rows[index];
    if (candidate === undefined || row === undefined || row.path !== candidate.path) {
      throw new CorruptError("sparse checkout hydration returned unordered rows");
    }
    if (
      !sameSparseLeaf(row.baseline, candidate.before) ||
      !sameSparseLeaf(row.current, candidate.after)
    ) {
      throw new CorruptError("sparse checkout hydration disagrees with the tree difference");
    }
    if (candidate.before === undefined) {
      if (row.index.length !== 0) return false;
      if (row.worktree !== null && row.worktree.type !== "dir") return false;
      continue;
    }
    const entry = row.index[0];
    if (
      row.index.length !== 1 ||
      entry === undefined ||
      entry.stage !== 0 ||
      entry.oid !== candidate.before.oid ||
      entry.mode !== Number.parseInt(candidate.before.mode, 8) ||
      row.worktree === null ||
      row.worktree.type === "dir" ||
      gitModeFor(row.worktree) !== candidate.before.mode
    ) {
      return false;
    }
  }
  return true;
}

function sameSparseLeaf(
  leaf: { mode: string; oid: string } | null,
  entry: TargetEntry | undefined,
): boolean {
  if (leaf === null || entry === undefined) return leaf === null && entry === undefined;
  return leaf.mode === entry.mode && leaf.oid === entry.oid;
}

export function sparseCheckoutWorktreeMatches(
  repo: Repository,
  worktree: Worktree,
  rows: readonly SparseWorkspaceRow[],
): boolean {
  const pending: Array<{ expected: TargetEntry; worktree: WorktreePath }> = [];
  for (const row of rows) {
    if (row.baseline === null) continue;
    const entry = row.index[0];
    if (entry === undefined || row.worktree === null || row.worktree.type === "dir") return false;
    const candidate: WorktreePath = { path: row.path, stat: row.worktree };
    if (!indexMatchesStat(entry, candidate.stat)) {
      pending.push({
        expected: { path: row.path, mode: row.baseline.mode, oid: row.baseline.oid },
        worktree: candidate,
      });
    }
  }
  const mapped = repo.store.lookupBlobIds(
    pending.flatMap(({ worktree: candidate }) => {
      const contentId = candidate.stat.contentId;
      return contentId === null ? [] : [contentId];
    }),
  );
  const unresolved: WorktreePath[] = [];
  const unresolvedExpected = new Map<string, TargetEntry>();
  for (const candidate of pending) {
    const contentId = candidate.worktree.stat.contentId;
    const oid = contentId === null ? undefined : mapped.get(contentIdKey(contentId));
    if (oid === candidate.expected.oid) continue;
    unresolved.push(candidate.worktree);
    unresolvedExpected.set(candidate.expected.path, candidate.expected);
  }
  const hashed = hashExactWorktreePathsOwned(repo, worktree, unresolved, {
    write: false,
  });
  for (const candidate of unresolved) {
    const expected = unresolvedExpected.get(candidate.path);
    const actual = hashed.get(candidate.path);
    if (
      expected === undefined ||
      actual === undefined ||
      actual.oid !== expected.oid ||
      actual.mode !== expected.mode
    ) {
      return false;
    }
  }
  return true;
}
