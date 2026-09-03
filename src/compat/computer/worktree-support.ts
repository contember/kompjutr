import { comparePaths, normalize } from "../../fs/path.js";
import type { RealPath } from "../../fs/types.js";
import type { WorktreeEntryType } from "../../git/ops/worktree/worktree.js";

export interface DirentLike {
  name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface ScanCandidate {
  path: string;
}

export function statType(stats: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}): WorktreeEntryType {
  if (stats.isSymbolicLink()) return "symlink";
  return stats.isDirectory() ? "dir" : "file";
}

export function codeOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return "code" in error ? error.code : undefined;
}

export function isMissing(error: unknown): boolean {
  const code = codeOf(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function assertRealPath(path: string): asserts path is RealPath {
  if (!path.startsWith("/") || normalize(path) !== path) {
    throw new Error(`Computer returned an invalid canonical path: '${path}'`);
  }
}

export function isExcluded(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => root === "/" || path === root || path.startsWith(`${root}/`));
}

export function pushCandidate(heap: ScanCandidate[], candidate: ScanCandidate): void {
  heap.push(candidate);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentEntry = heap[parent];
    if (parentEntry === undefined || comparePaths(parentEntry.path, candidate.path) <= 0) break;
    heap[index] = parentEntry;
    index = parent;
  }
  heap[index] = candidate;
}

export function popCandidate(heap: ScanCandidate[]): ScanCandidate | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined || heap.length === 0) return first;

  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    let child = left;
    const leftEntry = heap[left];
    const rightEntry = heap[right];
    if (
      rightEntry !== undefined &&
      leftEntry !== undefined &&
      comparePaths(rightEntry.path, leftEntry.path) < 0
    ) {
      child = right;
    }
    const childEntry = heap[child];
    if (childEntry === undefined || comparePaths(last.path, childEntry.path) <= 0) break;
    heap[index] = childEntry;
    index = child;
  }
  heap[index] = last;
  return first;
}

/**
 * dofs's `wrapDirent` hardcodes `isSymbolicLink: () => false` and derives
 * `isFile` from `type === "file"`, so a symlink answers false to all three
 * predicates. An inconclusive dirent therefore gets one `lstat` to settle
 * it — which only happens for symlinks, leaving the walk's hot path alone.
 */
export function entryType(entry: DirentLike): WorktreeEntryType | null {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  return null;
}
