// A tree as a lazy path-ordered stream.
//
// Git's tree order — where a subtree sorts as `name/` — makes the final
// depth-first paths ascend in the same UTF-8 byte order as the SQL index.

import type { Repository } from "../repository/repository.js";

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
