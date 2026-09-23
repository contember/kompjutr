import type { SqlDatabase } from "../../../db/db.js";
import { comparePaths, subtreeSuccessor } from "../../path.js";
import type { OrderedScanOptions, RealPath, ScanEntry } from "../../types.js";
import { scan } from "../scan.js";

/** Rows per keyset statement. This is also the metadata memory bound. */
export const SCAN_STREAM_PAGE = 1_000;

interface PrunedRange {
  directory: string;
  lower: string;
  upper: string;
}

/**
 * Everything under `root` in path byte order, one keyset statement per page.
 *
 * No SQL cursor stays open across a yield: each page restarts from the last
 * path returned, so the caller may write between rows. Rows under a pruned
 * directory are skipped in memory; a page that ends inside one restarts past
 * its whole subtree instead of reading it.
 */
export function* scanStream(
  db: SqlDatabase,
  root: RealPath,
  options: OrderedScanOptions = {},
): Generator<ScanEntry> {
  const pruned: PrunedRange[] = [];
  let after = options.after;
  let afterSubtree: string | undefined;
  while (true) {
    const page =
      afterSubtree === undefined
        ? scan(db, root, { after, filesOnly: options.filesOnly, limit: SCAN_STREAM_PAGE })
        : scan(db, root, { afterSubtree, filesOnly: options.filesOnly, limit: SCAN_STREAM_PAGE });
    afterSubtree = undefined;
    for (const entry of page) {
      after = entry.path;
      while (
        pruned.length > 0 &&
        comparePaths(entry.path, pruned[pruned.length - 1]?.upper ?? "") >= 0
      ) {
        pruned.pop();
      }
      const active = pruned[pruned.length - 1];
      if (active !== undefined && comparePaths(entry.path, active.lower) >= 0) continue;
      yield entry;
      if (entry.type === "dir" && options.pruneDirectory?.(entry.path) === true) {
        pruned.push({
          directory: entry.path,
          lower: `${entry.path}/`,
          upper: subtreeSuccessor(entry.path),
        });
      }
    }
    if (page.length < SCAN_STREAM_PAGE) return;

    const active = pruned[pruned.length - 1];
    const last = page[page.length - 1];
    if (
      active !== undefined &&
      last !== undefined &&
      comparePaths(last.path, active.lower) >= 0 &&
      comparePaths(last.path, active.upper) < 0
    ) {
      afterSubtree = active.directory;
      pruned.pop();
    }
  }
}
