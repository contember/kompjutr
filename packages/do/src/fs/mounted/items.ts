// The virtual namespace above the mounts, flattened into path order.
//
// Under a synthetic root the view holds point entries (synthetic directories
// and mount roots) and one contiguous range per mount (everything strictly
// under it). Mounts never nest, so no range contains another item, and
// sorting the items by where they start is the order `comparePaths` gives
// their rows. A page walks the items from its cursor; a range is one store
// statement over the mount's real subtree.

import type { SqlDatabase } from "../../db/db.js";
import { comparePaths, subtreeSuccessor } from "../path.js";
import { statRaw } from "../store/ops.js";
import { rebaseRealPath } from "../store/resolve.js";
import type { RealPath, ScanEntry, Stat } from "../types.js";
import { type Mount, type MountTable, realOf, virtualOf } from "./mounts.js";

export type Item =
  | { readonly kind: "synthetic"; readonly path: string }
  | { readonly kind: "mount-root"; readonly path: string; readonly mount: Mount }
  | {
      readonly kind: "tree";
      readonly mount: Mount;
      /** Virtual bounds: rows are `> lower` and `< upper`. */
      readonly lower: string;
      readonly upper: string;
    };

export function keyOf(item: Item): string {
  return item.kind === "tree" ? item.lower : item.path;
}

/** Every item strictly under the synthetic directory `root`, in path order. */
export function itemsUnder(table: MountTable, root: string): Item[] {
  const items: Item[] = table.syntheticUnder(root).map((path) => ({ kind: "synthetic", path }));
  for (const mount of table.mountsUnder(root)) {
    items.push({ kind: "mount-root", path: mount.path, mount });
    items.push({ kind: "tree", mount, ...mountBounds(mount) });
  }
  return items.sort((left, right) => comparePaths(keyOf(left), keyOf(right)));
}

/** Virtual bounds of everything strictly under a mount. */
export function mountBounds(mount: Mount): { lower: string; upper: string } {
  return { lower: `${mount.prefix}/`, upper: subtreeSuccessor(mount.path) };
}

/** Where a page resumes inside one item, or whether it skips the item. */
export type Resume =
  | { readonly kind: "skip" }
  | { readonly kind: "whole" }
  | { readonly kind: "after"; readonly real: string }
  | { readonly kind: "afterSubtree"; readonly real: string };

const SKIP: Resume = { kind: "skip" };
const WHOLE: Resume = { kind: "whole" };

function inMount(mount: Mount, path: string): boolean {
  return mount.prefix === "" || path === mount.path || path.startsWith(`${mount.prefix}/`);
}

function restOf(mount: Mount, path: string): string {
  return mount.prefix === "" ? (path === "/" ? "" : path) : path.slice(mount.prefix.length);
}

/** The real form of a virtual path known to lie in a mount. */
export function realIn(mount: Mount, path: string): string {
  return realOf(mount, restOf(mount, path));
}

/**
 * A keyset cursor's effect on one mount's rows, which lie strictly between
 * `lower` and `upper` in virtual order.
 */
export function resumeIn(
  mount: Mount,
  lower: string,
  upper: string,
  cursor: { readonly after?: string; readonly afterSubtree?: string },
): Resume {
  if (cursor.afterSubtree !== undefined) {
    const directory = cursor.afterSubtree;
    if (inMount(mount, directory)) return { kind: "afterSubtree", real: realIn(mount, directory) };
    const successor = subtreeSuccessor(directory);
    return comparePaths(successor, upper) >= 0 ? SKIP : WHOLE;
  }
  const after = cursor.after;
  if (after === undefined) return WHOLE;
  if (comparePaths(after, upper) >= 0) return SKIP;
  if (comparePaths(after, lower) < 0) return WHOLE;
  return { kind: "after", real: realIn(mount, after) };
}

/** Whether a point entry at `path` is past the cursor. */
export function pointVisible(
  path: string,
  cursor: { readonly after?: string; readonly afterSubtree?: string },
): boolean {
  if (cursor.afterSubtree !== undefined) {
    return comparePaths(path, subtreeSuccessor(cursor.afterSubtree)) >= 0;
  }
  return cursor.after === undefined || comparePaths(path, cursor.after) > 0;
}

/** A mount root's metadata is its source directory's. */
export function mountRootStat(db: SqlDatabase, source: RealPath): Stat | null {
  return statRaw(db, source);
}

export function virtualEntry(mount: Mount, entry: ScanEntry): ScanEntry {
  return { ...entry, path: virtualOf(mount, entry.path) };
}

/** A resolved real path under a mount's source, as the view's resolved path. */
export function virtualRealPath(mount: Mount, real: RealPath): RealPath {
  return rebaseRealPath(real, mount.source, mount.path);
}

/** A resolved virtual path in a mount, as the store's resolved path. */
export function realRealPath(mount: Mount, virtual: RealPath): RealPath {
  return rebaseRealPath(virtual, mount.path, mount.source);
}
