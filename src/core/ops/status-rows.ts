import { contentIdKey, type IndexEntry } from "../../sqlite/store.js";
import { isOid, ZERO_OID } from "../bytes.js";
import { CorruptError } from "../errors.js";
import type { IgnoreMatcher } from "../ignore/index.js";
import type { Repository } from "../repository.js";
import { comparePaths } from "../streams.js";
import { gitModeFor, type Worktree } from "../worktree.js";
import type { TargetEntry } from "./checkout.js";
import type {
  IgnoredStatusCode,
  OrdinaryStatusEntry,
  RenameStatusCode,
  StatusEntry,
  UnmergedStatusCode,
} from "./kinds.js";
import { validateMergePath } from "./merge-state.js";
import type { ExactRename } from "./rename-detection.js";
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
  staged: OrdinaryStatusEntry["index"];
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
export interface OrdinaryStatusDetail extends OrdinaryStatusEntry {
  readonly ignored?: false;
  readonly renamed?: false;
  readonly unmerged?: false;
  /** Mode in HEAD, in the index and on disk; "000000" where absent. */
  headMode: string;
  indexMode: string;
  worktreeMode: string;
  /** Oid in HEAD and in the index; all-zero where absent. */
  headOid: string;
  indexOid: string;
}

export interface UnmergedStatusDetail extends StatusEntry {
  readonly ignored?: false;
  readonly renamed?: false;
  readonly unmerged: true;
  index: UnmergedStatusCode;
  worktree: UnmergedStatusCode;
  baseMode: string;
  currentMode: string;
  incomingMode: string;
  worktreeMode: string;
  baseOid: string;
  currentOid: string;
  incomingOid: string;
}

export interface IgnoredStatusDetail extends StatusEntry {
  readonly ignored: true;
  readonly renamed?: false;
  readonly unmerged?: false;
  index: IgnoredStatusCode;
  worktree: IgnoredStatusCode;
}

export interface RenameStatusDetail extends StatusEntry {
  readonly ignored?: false;
  readonly renamed: true;
  readonly unmerged?: false;
  index: RenameStatusCode;
  worktree: OrdinaryStatusEntry["worktree"];
  originalPath: string;
  similarity: 100;
  headMode: string;
  indexMode: string;
  worktreeMode: string;
  headOid: string;
  indexOid: string;
}

export type StatusDetail =
  | OrdinaryStatusDetail
  | UnmergedStatusDetail
  | IgnoredStatusDetail
  | RenameStatusDetail;

export type StatusIndexGroup =
  | { kind: "tracked"; path: string; entry: IndexEntry }
  | {
      kind: "unmerged";
      path: string;
      base: IndexEntry | undefined;
      current: IndexEntry | undefined;
      incoming: IndexEntry | undefined;
    };

interface PendingStatusIndexGroup {
  path: string;
  lastStage: number;
  stageZero: IndexEntry | undefined;
  base: IndexEntry | undefined;
  current: IndexEntry | undefined;
  incoming: IndexEntry | undefined;
}

export interface StatusOptions {
  /** Restrict to these repo-relative pathspecs: exact or directory prefix. */
  paths?: string[];
  /** Roots of repositories nested inside this one; their files are theirs. */
  excludeRoots?: string[];
  /** Report ignored paths too. git's `--ignored`. */
  includeIgnored?: boolean;
  /** Override the ignore rules. Defaults to the working tree's `.gitignore`s. */
  ignores?: IgnoreMatcher;
  /**
   * "normal" (git's default) collapses a wholly untracked directory into
   * one `dir/` entry; "all" lists every file under it; "no" omits all
   * untracked and ignored rows.
   */
  untrackedFiles?: "no" | "normal" | "all";
  /** Detect staged exact renames. Explicit values override `status.renames`. */
  renames?: boolean;
}

/** Group a validated `(path, stage)` index stream without retaining the index. */
export function* statusIndexGroups(entries: Iterable<IndexEntry>): Generator<StatusIndexGroup> {
  let pending: PendingStatusIndexGroup | undefined;
  for (const entry of entries) {
    validateStatusIndexEntry(entry);
    if (pending === undefined || pending.path !== entry.path) {
      if (pending !== undefined) {
        if (comparePaths(pending.path, entry.path) >= 0) {
          throw new CorruptError("status index paths are not strictly ordered");
        }
        yield finishStatusIndexGroup(pending);
      }
      pending = {
        path: entry.path,
        lastStage: -1,
        stageZero: undefined,
        base: undefined,
        current: undefined,
        incoming: undefined,
      };
    }
    if (entry.stage <= pending.lastStage) {
      throw new CorruptError(`status index stages are not strictly ordered for ${entry.path}`);
    }
    pending.lastStage = entry.stage;
    if (entry.stage === 0) pending.stageZero = entry;
    else if (entry.stage === 1) pending.base = entry;
    else if (entry.stage === 2) pending.current = entry;
    else pending.incoming = entry;
  }
  if (pending !== undefined) yield finishStatusIndexGroup(pending);
}

export function oneStatusIndexGroup(
  entries: Iterable<IndexEntry>,
  expectedPath: string,
): StatusIndexGroup | undefined {
  let found: StatusIndexGroup | undefined;
  for (const group of statusIndexGroups(entries)) {
    if (found !== undefined || group.path !== expectedPath) {
      throw new CorruptError("sparse status returned index rows for the wrong path");
    }
    found = group;
  }
  return found;
}

function finishStatusIndexGroup(group: PendingStatusIndexGroup): StatusIndexGroup {
  const conflicted =
    group.base !== undefined || group.current !== undefined || group.incoming !== undefined;
  if (group.stageZero !== undefined) {
    if (conflicted) {
      throw new CorruptError(`status index mixes stage zero and conflict stages for ${group.path}`);
    }
    return { kind: "tracked", path: group.path, entry: group.stageZero };
  }
  if (!conflicted) throw new CorruptError(`status index path ${group.path} has no stages`);
  return {
    kind: "unmerged",
    path: group.path,
    base: group.base,
    current: group.current,
    incoming: group.incoming,
  };
}

function validateStatusIndexEntry(entry: IndexEntry): void {
  if (typeof entry.path !== "string") throw new CorruptError("status index path is not text");
  validateMergePath(entry.path, "status index path");
  if (!Number.isSafeInteger(entry.stage) || entry.stage < 0 || entry.stage > 3) {
    throw new CorruptError("status index stage is invalid");
  }
  if (
    !Number.isSafeInteger(entry.mode) ||
    (entry.mode !== 0o100644 &&
      entry.mode !== 0o100755 &&
      entry.mode !== 0o120000 &&
      entry.mode !== 0o160000)
  ) {
    throw new CorruptError("status index mode is invalid");
  }
  if (typeof entry.oid !== "string" || !isOid(entry.oid)) {
    throw new CorruptError("status index object id is invalid");
  }
  for (const value of [entry.size, entry.mtime, entry.ino, entry.rev]) {
    if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new CorruptError("status index metadata is invalid");
    }
  }
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

  let staged: OrdinaryStatusEntry["index"] = " ";
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
  | { kind: "ready"; code: OrdinaryStatusEntry["worktree"]; mode: string }
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
    const code: OrdinaryStatusEntry["worktree"] =
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
  staged: OrdinaryStatusEntry["index"],
  code: OrdinaryStatusEntry["worktree"],
  headMode: string,
  indexMode: string,
  worktreeMode: string,
  headOid: string,
  indexOid: string,
): OrdinaryStatusDetail {
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

export function ignoredRow(path: string): IgnoredStatusDetail {
  return { ignored: true, path, index: "!", worktree: "!" };
}

export function renameRow(
  rename: ExactRename,
  destination: OrdinaryStatusDetail,
): RenameStatusDetail {
  if (
    destination.index !== "A" ||
    destination.path !== rename.destination.path ||
    destination.indexMode !== rename.destination.mode ||
    destination.indexOid !== rename.destination.oid
  ) {
    throw new CorruptError("status rename destination does not match its staged addition");
  }
  return {
    renamed: true,
    path: destination.path,
    originalPath: rename.source.path,
    similarity: 100,
    index: "R",
    worktree: destination.worktree,
    headMode: rename.source.mode,
    indexMode: destination.indexMode,
    worktreeMode: destination.worktreeMode,
    headOid: rename.source.oid,
    indexOid: destination.indexOid,
  };
}

export function unmergedRow(
  group: Extract<StatusIndexGroup, { kind: "unmerged" }>,
  worktree: WorktreePath | undefined,
): UnmergedStatusDetail {
  const [index, worktreeCode] = unmergedCodes(group);
  return {
    unmerged: true,
    path: group.path,
    index,
    worktree: worktreeCode,
    baseMode: indexMode(group.base),
    currentMode: indexMode(group.current),
    incomingMode: indexMode(group.incoming),
    worktreeMode:
      worktree === undefined || worktree.stat.type === "dir"
        ? ABSENT_MODE
        : gitModeFor(worktree.stat),
    baseOid: group.base?.oid ?? ZERO_OID,
    currentOid: group.current?.oid ?? ZERO_OID,
    incomingOid: group.incoming?.oid ?? ZERO_OID,
  };
}

function unmergedCodes(
  group: Extract<StatusIndexGroup, { kind: "unmerged" }>,
): readonly [UnmergedStatusCode, UnmergedStatusCode] {
  const base = group.base !== undefined;
  const current = group.current !== undefined;
  const incoming = group.incoming !== undefined;
  if (base && !current && !incoming) return ["D", "D"];
  if (!base && current && !incoming) return ["A", "U"];
  if (base && current && !incoming) return ["U", "D"];
  if (!base && !current && incoming) return ["U", "A"];
  if (base && !current && incoming) return ["D", "U"];
  if (!base && current && incoming) return ["A", "A"];
  if (base && current && incoming) return ["U", "U"];
  throw new CorruptError(`status index path ${group.path} has no conflict stages`);
}

function indexMode(entry: IndexEntry | undefined): string {
  return entry === undefined ? ABSENT_MODE : octalMode(entry.mode);
}

export function octalMode(mode: number): string {
  return mode.toString(8).padStart(6, "0");
}
