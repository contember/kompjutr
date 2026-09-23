import type { SparseWorkspaceRow } from "../../store/core/contracts.js";
import { contentIdKey } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import type { TargetEntry } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import {
  hashExactWorktreePaths,
  indexMatchesStat,
  type WorktreePath,
} from "../worktree/worktree-io.js";

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
  const hashed = hashExactWorktreePaths(repo, worktree, unresolved, {
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
