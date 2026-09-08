// Path primitives for the filesystem layer. Pure functions, no SQL.
//
// `src/git/common/paths.ts` carries near-identical helpers for the git core. The
// two are not merged here because the filesystem must not depend on the git
// layer and wave B is additive only; they collapse in the integration wave.

import { filesystemError } from "./errors.js";

/**
 * Reject a path that is not well-formed UTF-16, exactly as `src/git` does
 * (ADR-0007). A lone surrogate stores as WTF-8 through a JSON binding and as
 * U+FFFD through a direct bind, so the name read back is not the name written.
 */
export function assertWellFormedPath(path: string, what = "path"): void {
  if (!path.isWellFormed()) {
    throw filesystemError("EINVAL", `${what} is not well-formed UTF-8`, path);
  }
}

/** Lexical normalisation. Does NOT resolve symlinks — see `realpath`. */
export function normalize(path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

export function join(root: string, relative: string): string {
  if (relative === "" || relative === ".") return normalize(root);
  return normalize(`${root.replace(/\/+$/, "")}/${relative}`);
}

export function dirname(path: string): string {
  const normalized = normalize(path);
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export function basename(path: string): string {
  const normalized = normalize(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** The segments of an absolute path, root excluded. `/` gives `[]`. */
export function segments(path: string): string[] {
  const normalized = normalize(path);
  return normalized === "/" ? [] : normalized.slice(1).split("/");
}

/**
 * The first path that sorts after everything under `dir`, so a subtree is
 * `WHERE path > dir AND path < subtreeSuccessor(dir)`.
 *
 * `'0'` is 0x30 and `'/'` is 0x2F, so `dir + "0"` is the immediate successor
 * of `dir + "/"` under BINARY collation. That is also why `a.txt` sorts
 * before `a/x`: `'.'` is 0x2E.
 */
export function subtreeSuccessor(dir: string): string {
  const normalized = normalize(dir);
  return normalized === "/" ? "0" : `${normalized}0`;
}

/**
 * Path order under BINARY collation, which is UTF-8 byte order, which is
 * git's tree order when a directory sorts as `name/`.
 *
 * Compares code points rather than UTF-16 units so an astral character
 * cannot sort before a BMP one it should follow.
 */
export function comparePaths(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const l = left[i]?.codePointAt(0) ?? 0;
    const r = right[i]?.codePointAt(0) ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * Length in code points, which is what SQLite's `substr()` counts over TEXT.
 *
 * Over a BLOB it counts bytes instead. Mixing the two is silent: no error,
 * the right number of rows, every value after the first non-ASCII byte
 * sliced at the wrong boundary.
 */
export function codePointLength(value: string): number {
  return [...value].length;
}
