// The filesystem slice the git core consumes. It stays synchronous because
// every hot path runs inside one Durable Object turn.

import type { Dirent, EntryType, Filesystem, Stat } from "../fs/types.js";

export type WorktreeEntryType = EntryType;
export type WorktreeStat = Stat;
export type WorktreeDirent = Dirent;

export type Worktree = Pick<
  Filesystem,
  | "stat"
  | "readFile"
  | "readRange"
  | "readlink"
  | "readdir"
  | "scan"
  | "readFiles"
  | "glob"
  | "writeFile"
  | "createFile"
  | "writeRange"
  | "symlink"
  | "unlink"
  | "rmdir"
  | "chmod"
  | "writeFiles"
  | "makeDirectories"
  | "removeFiles"
>;

/** The git tree mode for a working-tree entry. */
export function gitModeFor(stat: WorktreeStat): string {
  if (stat.type === "symlink") return "120000";
  if (stat.type === "dir") return "40000";
  return (stat.mode & 0o111) !== 0 ? "100755" : "100644";
}

/** The filesystem mode a git tree mode should be materialised with. */
export function fileModeFor(gitMode: string): number {
  return gitMode === "100755" ? 0o755 : 0o644;
}
