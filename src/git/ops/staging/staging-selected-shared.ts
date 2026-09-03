import { comparePaths } from "../../common/paths.js";
import type { IndexEntry } from "../../store/index.js";

export function hasExactSelectedIndexPath(rows: readonly IndexEntry[], path: string): boolean {
  return rows[lowerBoundSelectedPath(rows, path)]?.path === path;
}

export function lowerBoundSelectedPath<T extends { path: string }>(
  rows: readonly T[],
  path: string,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = rows[middle];
    if (candidate !== undefined && comparePaths(candidate.path, path) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}
