import { contentIdKey, type IndexEntry } from "../../sqlite/store.js";
import { ZERO_OID } from "../bytes.js";
import type { IgnoreMatcher } from "../ignore/index.js";
import type { Repository } from "../repository.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import type { TargetEntry } from "./checkout.js";
import type { StatusEntry } from "./kinds.js";
import {
  type HashedPath,
  hashExactWorktreePaths,
  hashWorktreePaths,
  indexMatchesStat,
  type WorktreePath,
} from "./worktree-io.js";

/** A mode column in porcelain v2, and the mode of an absent side. */
const ABSENT_MODE = "000000";

interface PendingTrackedRow {
  path: string;
  headMode: string;
  indexMode: string;
  worktree: WorktreePath;
  headOid: string;
  indexOid: string;
  staged: StatusEntry["index"];
}

export type BufferedStatusRow =
  | { kind: "ready"; detail: StatusDetail }
  | { kind: "hash"; tracked: PendingTrackedRow };

export interface StatusHashObserver {
  observeHashed(path: string, dirty: boolean): void;
}

/**
 * A `StatusEntry` plus the columns porcelain v2 prints. `status` returns
 * these so the v2 formatter needs no second pass over the repository;
 * anything wanting Computer's narrower shape can use it as-is.
 */
export interface StatusDetail extends StatusEntry {
  /** Mode in HEAD, in the index and on disk; "000000" where absent. */
  headMode: string;
  indexMode: string;
  worktreeMode: string;
  /** Oid in HEAD and in the index; all-zero where absent. */
  headOid: string;
  indexOid: string;
}

export interface StatusOptions {
  /** Restrict to these repo-relative pathspecs: exact or directory prefix. */
  paths?: string[];
  /** Roots of repositories nested inside this one; their files are theirs. */
  excludeRoots?: string[];
  /** Report ignored paths too, as untracked. git's `--ignored`. */
  includeIgnored?: boolean;
  /** Override the ignore rules. Defaults to the working tree's `.gitignore`s. */
  ignores?: IgnoreMatcher;
  /**
   * "normal" (git's default) collapses a wholly untracked directory into
   * one `dir/` entry; "all" lists every file under it.
   */
  untrackedFiles?: "normal" | "all";
}

export function trackedRow(
  path: string,
  head: TargetEntry | undefined,
  entry: IndexEntry | undefined,
  worktree: WorktreePath | undefined,
): BufferedStatusRow | null {
  const headMode = head?.mode ?? ABSENT_MODE;
  const headOid = head?.oid ?? ZERO_OID;
  const indexMode = entry === undefined ? ABSENT_MODE : octalMode(entry.mode);
  const indexOid = entry?.oid ?? ZERO_OID;

  let staged: StatusEntry["index"] = " ";
  if (head === undefined) staged = entry === undefined ? " " : "A";
  else if (entry === undefined) staged = "D";
  else if (head.oid !== entry.oid || head.mode !== indexMode) staged = "M";

  const state = worktreeState(entry, worktree, {
    path,
    headMode,
    indexMode,
    headOid,
    indexOid,
    staged,
  });
  if (state.kind === "hash") return state;
  const { code, mode } = state;
  if (staged === " " && code === " ") return null;
  return {
    kind: "ready",
    detail: statusDetail(path, staged, code, headMode, indexMode, mode, headOid, indexOid),
  };
}

/** The working-tree half of a tracked path, hashing only when it must. */
function worktreeState(
  entry: IndexEntry | undefined,
  worktree: WorktreePath | undefined,
  pending: Omit<PendingTrackedRow, "worktree">,
):
  | { kind: "ready"; code: StatusEntry["worktree"]; mode: string }
  | { kind: "hash"; tracked: PendingTrackedRow } {
  // Not in the index: the file, if any, shows up as untracked instead.
  if (entry === undefined) return { kind: "ready", code: " ", mode: ABSENT_MODE };
  // Submodules are out of scope; nothing on disk describes their state.
  if (entry.mode === 0o160000) {
    return { kind: "ready", code: " ", mode: octalMode(entry.mode) };
  }

  if (worktree === undefined) return { kind: "ready", code: "D", mode: ABSENT_MODE };
  const mode = gitModeFor(worktree.stat);
  if (indexMatchesStat(entry, worktree.stat)) return { kind: "ready", code: " ", mode };
  return { kind: "hash", tracked: { ...pending, worktree } };
}

export function* flushStatusRows(
  repo: Repository,
  worktree: Worktree,
  buffered: BufferedStatusRow[],
  observer?: StatusHashObserver,
  exact = false,
  knownHashes: ReadonlyMap<string, HashedPath> = new Map(),
): Generator<StatusDetail> {
  if (buffered.length === 0) return;
  const rows = buffered.splice(0);
  const pending = rows.flatMap((row) => (row.kind === "hash" ? [row.tracked] : []));
  const mapped = repo.store.lookupBlobIds(
    pending.flatMap((row) => {
      const contentId = row.worktree.stat.contentId;
      return contentId === null || row.worktree.stat.type === "dir" ? [] : [contentId];
    }),
  );
  const mappedOids = new Map<string, string>();
  const unresolved: WorktreePath[] = [];
  for (const row of pending) {
    const contentId = row.worktree.stat.contentId;
    const oid =
      contentId === null || row.worktree.stat.type === "dir"
        ? undefined
        : mapped.get(contentIdKey(contentId));
    if (oid === undefined) {
      if (!knownHashes.has(row.path)) unresolved.push(row.worktree);
    } else mappedOids.set(row.path, oid);
  }
  const freshHashes = exact
    ? hashExactWorktreePaths(repo, worktree, unresolved, { write: false })
    : hashWorktreePaths(repo, worktree, unresolved, { write: false });
  repo.store.upsertBlobIds(
    [...freshHashes.values()].flatMap((hashed) => {
      const contentId = hashed.stat.contentId;
      return contentId === null ? [] : [{ contentId, oid: hashed.oid }];
    }),
  );
  const hashes = new Map(knownHashes);
  for (const [path, hashed] of freshHashes) hashes.set(path, hashed);
  for (const row of rows) {
    if (row.kind === "ready") {
      yield row.detail;
      continue;
    }
    const tracked = row.tracked;
    const hashed = hashes.get(tracked.path);
    const actualOid = mappedOids.get(tracked.path) ?? hashed?.oid;
    const actualMode = hashed?.mode ?? gitModeFor(tracked.worktree.stat);
    const code: StatusEntry["worktree"] =
      actualOid === undefined
        ? "D"
        : actualOid !== tracked.indexOid || actualMode !== tracked.indexMode
          ? "M"
          : " ";
    observer?.observeHashed(tracked.path, code !== " ");
    if (tracked.staged === " " && code === " ") continue;
    yield statusDetail(
      tracked.path,
      tracked.staged,
      code,
      tracked.headMode,
      tracked.indexMode,
      actualOid === undefined ? ABSENT_MODE : actualMode,
      tracked.headOid,
      tracked.indexOid,
    );
  }
}

function statusDetail(
  path: string,
  staged: StatusEntry["index"],
  code: StatusEntry["worktree"],
  headMode: string,
  indexMode: string,
  worktreeMode: string,
  headOid: string,
  indexOid: string,
): StatusDetail {
  return {
    path,
    index: staged,
    worktree: code,
    headMode,
    indexMode,
    worktreeMode,
    headOid,
    indexOid,
  };
}

export function untrackedRow(path: string): StatusDetail {
  return statusDetail(path, " ", "?", ABSENT_MODE, ABSENT_MODE, ABSENT_MODE, ZERO_OID, ZERO_OID);
}

export function octalMode(mode: number): string {
  return mode.toString(8).padStart(6, "0");
}
