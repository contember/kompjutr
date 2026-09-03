import { GitError } from "../../common/errors.js";
import { isPathRoot, relativeTo } from "../../common/paths.js";
import { RM_MAX_ROWS_PER_STREAM } from "./staging-rm-types.js";

export const ADD_RETAINED_BYTES = 16 * 1024 * 1024;

export function structuralStringBytes(value: string): number {
  return 48 + value.length * 2;
}

export function relativeExcludeRoots(root: string, paths: readonly string[] | undefined): string[] {
  const relatives: string[] = [];
  for (const path of paths ?? []) {
    const relative = relativeTo(root, path);
    if (relative === null || relative === "") continue;
    relatives.push(relative);
  }
  return relatives;
}

export function isExcluded(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathRoot(root, path));
}

export function* boundedRmRows<T>(rows: Iterable<T>, label: string): Generator<T> {
  let count = 0;
  for (const row of rows) {
    if (count >= RM_MAX_ROWS_PER_STREAM) {
      throw new GitError("E2BIG", `rm ${label} scan exceeds ${RM_MAX_ROWS_PER_STREAM} rows`);
    }
    count++;
    yield row;
  }
}

export function requireRmRetained(bytes: number): void {
  if (bytes > ADD_RETAINED_BYTES) {
    throw new GitError("E2BIG", `rm retained state exceeds ${ADD_RETAINED_BYTES} bytes`);
  }
}
