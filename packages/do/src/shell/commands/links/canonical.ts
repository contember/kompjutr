// Path canonicalisation for readlink -f/-e/-m, realpath, and ln -r.
//
// The common case is one `realpath` statement: the store resolves every
// symlink itself. Only `-m` needs more, when the store refuses a path that
// continues past a missing entry or a regular file; uutils then keeps
// resolving what does exist, so that fallback walks component by component,
// one `stat` each, bounded by the path's length and the follow limit.

import { filesystemError } from "../../../fs/errors.js";
import { dirname, normalize } from "../../../fs/path.js";
import type { BoundedFs } from "../../exec/context.js";
import { isFilesystemError } from "../../exec/redirections.js";

/** uutils' MissingHandling: which components must exist. */
export type Existence = "existing" | "normal" | "missing";

/** POSIX's own guidance, and the store's limit. */
const MAX_FOLLOWS = 40;

/**
 * The operand joined to cwd without lexical normalisation: `link/..` must
 * resolve the link first, and a trailing slash demands a directory. An empty
 * operand names cwd, as uutils' canonicalisation treats it.
 */
export function unresolved(cwd: string, operand: string): string {
  if (operand.startsWith("/")) return operand;
  if (operand === "") return cwd;
  return `${cwd}/${operand}`;
}

/** Resolve every symlink; throws a filesystem error carrying the uutils-visible code. */
export function canonicalize(fs: BoundedFs, path: string, existence: Existence): string {
  let real: string;
  try {
    real = fs.realpath(path);
  } catch (error) {
    if (
      existence === "missing" &&
      isFilesystemError(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return walk(fs, path);
    }
    throw error;
  }
  if (existence === "existing" && fs.stat(real) === null) {
    throw filesystemError("ENOENT", "no such file or directory", path);
  }
  if (existence === "normal" && real !== "/" && fs.stat(dirname(real)) === null) {
    throw filesystemError("ENOENT", "no such file or directory", path);
  }
  return real;
}

/** `realpath -s`: lexical, with the parent checked only under normal existence. */
export function canonicalizeLexically(fs: BoundedFs, path: string, existence: Existence): string {
  const lexical = normalize(path);
  if (existence !== "normal" || lexical === "/") return lexical;
  const parent = fs.statTarget(dirname(lexical));
  if (parent === null) throw filesystemError("ENOENT", "no such file or directory", path);
  if (parent.type !== "dir") throw filesystemError("ENOTDIR", "not a directory", path);
  return lexical;
}

function walk(fs: BoundedFs, path: string): string {
  let resolved: string[] = [];
  let pending = path.split("/");
  let follows = 0;
  while (pending.length > 0) {
    const [component, ...rest] = pending;
    pending = rest;
    if (component === undefined || component === "" || component === ".") continue;
    if (component === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(component);
    const found = fs.stat(`/${resolved.join("/")}`);
    if (found?.type !== "symlink" || found.target === null) continue;

    follows++;
    if (follows > MAX_FOLLOWS) throw filesystemError("ELOOP", "too many symbolic links", path);
    resolved.pop();
    if (found.target.startsWith("/")) resolved = [];
    pending = [...found.target.split("/"), ...pending];
  }
  return `/${resolved.join("/")}`;
}

/** Whether `path` is `base` or lies beneath it. Both are canonical. */
export function within(path: string, base: string): boolean {
  return base === "/" || path === base || path.startsWith(`${base}/`);
}

/** The relative spelling of canonical `to`, seen from canonical directory `from`. */
export function relativeTo(from: string, to: string): string {
  const fromParts = parts(from);
  const toParts = parts(to);
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared] === toParts[shared]
  ) {
    shared++;
  }
  const up = fromParts.slice(shared).map(() => "..");
  const down = toParts.slice(shared);
  const joined = [...up, ...down].join("/");
  return joined === "" ? "." : joined;
}

function parts(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}
