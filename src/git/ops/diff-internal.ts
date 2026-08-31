import type { IndexEntry } from "../store/index.js";
import type { TargetEntry } from "./tree-stream.js";
import type { WorktreePath } from "./worktree-io.js";

export interface DiffOptions {
  /** The "from" side. Defaults to HEAD. */
  ref?: string;
  /** The "to" side. Set it to diff two commits instead of the working tree. */
  to?: string;
  /** Exact-or-directory-prefix path filter. No globs. */
  paths?: string[];
  /** Context lines around each hunk. */
  context?: number;
  /** Length of the abbreviated oids on `index` lines. */
  abbrev?: number;
  /** Detect exact renames. Explicit values override `diff.renames`. */
  renames?: boolean;
}

export interface EndpointIdentity {
  mode: string;
  oid: string;
  worktree: WorktreePath | null;
}

export interface PendingChange {
  path: string;
  before: EndpointIdentity | null;
  after: EndpointIdentity | null;
}

export interface WorkingCandidate {
  path: string;
  before: TargetEntry | undefined;
  index: IndexEntry | undefined;
  worktree: WorktreePath | undefined;
}

/** A change, or null when the two identities agree or neither exists. */
export function compareIdentities(
  path: string,
  before: EndpointIdentity | null,
  after: EndpointIdentity | null,
): PendingChange | null {
  if (before === null && after === null) return null;
  if (before !== null && after !== null && before.oid === after.oid && before.mode === after.mode) {
    return null;
  }
  return { path, before, after };
}

export function treeIdentity(entry: TargetEntry | undefined): EndpointIdentity | null {
  // Submodules are out of scope.
  if (entry === undefined || entry.mode === "160000") return null;
  return { mode: entry.mode, oid: entry.oid, worktree: null };
}
