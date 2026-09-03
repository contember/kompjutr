import { isOid } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import {
  hashObject,
  MODE_COMMIT,
  MODE_EXECUTABLE,
  MODE_FILE,
  MODE_SYMLINK,
} from "../common/objects.js";
import { comparePaths } from "../common/streams.js";
import type { TouchedSpec, TouchedSpecs } from "./merge-apply-types.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import {
  MAX_MERGE_TOUCHED_PATHS,
  type MergeTouchedPath,
  validateMergePath,
} from "./merge-state.js";

function validMode(mode: string): boolean {
  return mode === MODE_FILE || mode === MODE_EXECUTABLE || mode === MODE_SYMLINK;
}

export function requireIdentity(mode: string, oid: string, path: string): number {
  if (mode === MODE_COMMIT) {
    throw new GitError("EUNSUPPORTED", `merge cannot materialise gitlink ${path}`);
  }
  if (!validMode(mode)) throw new CorruptError(`merge entry ${path} has an invalid mode`);
  if (!isOid(oid)) throw new CorruptError(`merge entry ${path} has an invalid object id`);
  return Number.parseInt(mode, 8);
}

export function validateProjectedIndexEntries(entries: readonly ProjectedMergeEntry[]): void {
  if (entries.length > MAX_MERGE_TOUCHED_PATHS) {
    throw new GitError("E2BIG", `merge apply exceeds ${MAX_MERGE_TOUCHED_PATHS} projected paths`);
  }
  let previous: string | null = null;
  for (const entry of entries) {
    validateMergePath(entry.path, "projected path");
    validateMergePath(entry.logicalPath, "projected logical path");
    if (previous !== null && comparePaths(previous, entry.path) >= 0) {
      throw new CorruptError("projected merge entries are not in strict Git path order");
    }
    if (entry.purpose === "primary" && entry.path !== entry.logicalPath) {
      throw new CorruptError("projected merge primary path differs from its logical path");
    }
    if (entry.purpose !== "primary" && entry.path === entry.logicalPath) {
      throw new CorruptError("projected merge relocation equals its logical path");
    }
    if ((entry.stageZero === null) === (entry.stages === null)) {
      if (entry.stageZero !== null || entry.stages !== null) {
        throw new CorruptError(`projected merge entry ${entry.path} has conflicting index forms`);
      }
    }
    if (
      entry.purpose !== "primary" &&
      entry.purpose !== "current-relocation" &&
      entry.purpose !== "incoming-relocation"
    ) {
      throw new CorruptError("projected merge entry has an invalid purpose");
    }
    if (entry.stageZero !== null) {
      requireIdentity(entry.stageZero.mode, entry.stageZero.oid, entry.path);
    }
    if (entry.stages !== null) {
      if (
        entry.stages.base === null &&
        entry.stages.current === null &&
        entry.stages.incoming === null
      ) {
        throw new CorruptError(`projected merge entry ${entry.path} has no conflict stages`);
      }
      for (const identity of [entry.stages.base, entry.stages.current, entry.stages.incoming]) {
        if (identity !== null) requireIdentity(identity.mode, identity.oid, entry.path);
      }
    }
    if (entry.worktree !== null) {
      requireIdentity(entry.worktree.mode, entry.worktree.oid, entry.path);
    }
    if (entry.content !== null && entry.worktree === null) {
      throw new CorruptError(`projected merge entry ${entry.path} has orphaned content`);
    }
    if (
      entry.content !== null &&
      entry.worktree !== null &&
      entry.worktree.mode !== MODE_FILE &&
      entry.worktree.mode !== MODE_EXECUTABLE
    ) {
      throw new CorruptError(`projected merge entry ${entry.path} has non-file content`);
    }
    if (
      entry.content !== null &&
      entry.stageZero !== null &&
      hashObject("blob", entry.content) !== entry.stageZero.oid
    ) {
      throw new CorruptError(`merged content identity does not match ${entry.path}`);
    }
    previous = entry.path;
  }
}

export function touchedSpecs(entries: readonly ProjectedMergeEntry[]): TouchedSpecs {
  const byPath = new Map<string, TouchedSpec>();
  const retain = (
    path: string,
    logicalPath: string,
    purpose: MergeTouchedPath["purpose"],
  ): void => {
    if (byPath.has(path)) return;
    if (byPath.size >= MAX_MERGE_TOUCHED_PATHS) {
      throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`);
    }
    const spec: TouchedSpec = { path, logicalPath, purpose };
    byPath.set(spec.path, spec);
  };
  const retainAncestor = (path: string): void => {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const ancestor = path.slice(0, slash);
      retain(ancestor, ancestor, "primary");
      slash = ancestor.lastIndexOf("/");
    }
  };
  for (const entry of entries) {
    retain(entry.path, entry.logicalPath, entry.purpose);
    if (entry.purpose !== "primary" && !byPath.has(entry.logicalPath)) {
      retain(entry.logicalPath, entry.logicalPath, "primary");
    }
    retainAncestor(entry.path);
    retainAncestor(entry.logicalPath);
  }
  const specs = [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
  return { entries: specs };
}
