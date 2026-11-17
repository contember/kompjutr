// Git's two-way merge for a branch switch, as the target checkout applies.
// A path HEAD and the target agree on keeps its staged entry; a path the
// switch takes from the target replaces any kept entry it collides with as
// file versus directory, so the index never holds both.

import { comparePaths, joinSorted3 } from "../../common/streams.js";
import type { IndexEntry } from "../../store/index.js";
import type { TargetEntry } from "../tree/tree-stream.js";
import { targetFromIndex } from "./checkout-support.js";

/** Both absent, or the same object at the same mode. */
export function sameTreeEntry(
  left: TargetEntry | undefined,
  right: TargetEntry | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.oid === right.oid && left.mode === right.mode;
}

/**
 * The target as the two-way merge applies it: where `baseline` and `target`
 * agree, the current stage-0 entry, or its absence, stands in for the target.
 * A kept file with a taken path below it is only known once that path streams
 * past, which can be after unrelated siblings (`a`, `a.txt`, `a/b`), so the
 * guard's `replaced` set names those files up front.
 */
export function* carriedTarget(
  target: Iterable<TargetEntry>,
  baseline: Iterable<TargetEntry>,
  index: Iterable<IndexEntry>,
  replaced: ReadonlySet<string>,
): Generator<TargetEntry> {
  // Taken leaves whose `<path>/` subtree may still follow, innermost last.
  const leaves: string[] = [];
  for (const row of joinSorted3(target, baseline, targetFromIndex(index), {
    a: (entry) => entry.path,
    b: (entry) => entry.path,
    c: (entry) => entry.path,
  })) {
    while (leaves.length > 0 && comparePaths(row.path, `${leaves[leaves.length - 1]}0`) >= 0) {
      leaves.pop();
    }
    if (!sameTreeEntry(row.a, row.b)) {
      if (row.a === undefined) continue;
      leaves.push(row.path);
      yield row.a;
      continue;
    }
    const kept = row.c;
    if (kept === undefined || replaced.has(kept.path)) continue;
    if (leaves.some((leaf) => kept.path.startsWith(`${leaf}/`))) continue;
    yield kept;
  }
}
