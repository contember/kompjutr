// View types shared by the commands. These mirror the shapes Computer's
// `GitClient` interface returns, so the facade in `src/computer/` is a
// direct hand-off with no translation layer.
//
// FROZEN SEAM: every command depends on these. Changing one invalidates
// work in flight elsewhere.

export type { CatFileResult, CommitView, TreeEntryView } from "./reads.js";

/**
 * `Person.timezoneOffset` is minutes **west** of UTC — `+0100` is `-60`,
 * the `Date.prototype.getTimezoneOffset` convention. That is what
 * isomorphic-git returns at runtime and therefore what Computer's
 * `CommitView` actually carries, whatever its doc comment says. Anything
 * formatting a commit date has to negate.
 */

export interface StatusEntry {
  path: string;
  index: " " | "A" | "M" | "D";
  worktree: " " | "A" | "M" | "D" | "?";
}

/**
 * isomorphic-git's `statusMatrix` row shape, kept for callers that already
 * speak it: `[filepath, head, workdir, stage]` where 0 = absent,
 * 1 = present and equal to HEAD, 2 = present and different, 3 = present
 * and different from both.
 */
export type StatusRow = [filepath: string, head: number, workdir: number, stage: number];

export interface DiffSummaryEntry {
  path: string;
  status: "A" | "M" | "D";
  insertions: number;
  deletions: number;
}

export interface CommitResult {
  oid: string;
}

export interface RemoteView {
  name: string;
  url: string;
}

export interface RefUpdateStatus {
  ok: boolean;
  error?: string;
}

export interface PushResult {
  ok: boolean;
  error: string | null;
  refs: Record<string, RefUpdateStatus>;
}

export interface MergeResult {
  oid?: string;
  alreadyMerged?: boolean;
  fastForward?: boolean;
  /** The index contains unresolved stages and the merge can be continued or aborted. */
  conflicted?: boolean;
  /** The merge has durable state but has not created its merge commit yet. */
  pendingCommit?: boolean;
}
