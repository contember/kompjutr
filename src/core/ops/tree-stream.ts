// A tree as a lazy, path-ordered stream.
//
// `Repository.walkTree` is already a depth-first generator, and git's tree
// order — where a subtree sorts as `name/` — makes its full paths ascend in
// UTF-8 byte order, the same order `comparePaths` and the SQL index give. So
// a tree, the index and the working tree can be merged directly.
//
// Bound: O(sum of the widths of the directories currently open), because
// `readTree` materialises one directory at a time. A flat tree of N entries
// is still O(N) — nothing here can fix that without an incremental tree
// parser.

import type { Repository } from "../repository.js";

/** A blob, symlink or gitlink under a tree, keyed by repo-relative path. */
export interface TargetEntry {
  path: string;
  mode: string;
  oid: string;
}

export function* treeStream(repo: Repository, treeOid: string | null): Generator<TargetEntry> {
  if (treeOid === null) return;
  for (const { path, entry } of repo.walkTree(treeOid)) {
    yield { path, mode: entry.mode, oid: entry.oid };
  }
}
