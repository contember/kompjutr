import { nativeRealpathOwned, nativeScanOwned } from "../../fs/store/owned-read.js";
import type { RealPath, ScanEntry } from "../../fs/types.js";
import { CorruptError, GitError } from "../common/errors.js";
import { joinPath, relativeTo } from "../common/paths.js";
import { comparePaths } from "../common/streams.js";
import { indexScanOwned } from "../store/index.js";
import type {
  IndexSnapshots,
  SnapshotDraft,
  SnapshotObjects,
  TouchedSpec,
  WorktreeSnapshotScan,
} from "./merge-apply-types.js";
import type { MergeIndexSnapshot, MergeTouchedPath, MergeWorktreeSnapshot } from "./merge-state.js";
import type { Repository } from "./repository.js";
import type { Worktree, WorktreeStat } from "./worktree.js";
import { type HashedPath, hashExactWorktreePathsOwned } from "./worktree-io.js";

const APPLY_SCAN_PAGE = 1_000;

function validateCanonicalUtf16(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new CorruptError(`${label} is not canonical UTF-16`);
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError(`${label} is not canonical UTF-16`);
    }
  }
}

function lowerBound(paths: readonly string[], wanted: string): number {
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    const path = paths[middle];
    if (path !== undefined && comparePaths(path, wanted) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function ownedPathOrAncestor(
  path: string,
  owned: readonly string[],
  exact: ReadonlySet<string>,
): boolean {
  if (exact.has(path)) return true;
  const index = lowerBound(owned, `${path}/`);
  return owned[index]?.startsWith(`${path}/`) === true;
}

function destructiveOwner(path: string, roots: readonly string[]): string | null {
  const index = lowerBound(roots, path);
  if (roots[index] === path) return path;
  const previous = roots[index - 1];
  return previous !== undefined && path.startsWith(`${previous}/`) ? previous : null;
}

function pathDescendsFrom(path: string, root: string): boolean {
  return path.length > root.length && path.startsWith(root) && path.charCodeAt(root.length) === 47;
}

function worktreeRealpathOwned(worktree: Worktree, path: string): RealPath {
  const native = nativeRealpathOwned(worktree, path);
  if (native !== null) return native;
  return worktree.realpath(path);
}

function worktreeScanPageOwned(
  worktree: Worktree,
  root: RealPath,
  after: string | undefined,
): ScanEntry[] {
  const native = nativeScanOwned(worktree, root, { after, limit: APPLY_SCAN_PAGE });
  if (native !== null) return native;
  return worktree.scan(root, { after, limit: APPLY_SCAN_PAGE });
}

export function worktreeSnapshotScan(
  repo: Repository,
  worktree: Worktree,
  specs: readonly TouchedSpec[],
  destructiveRoots: readonly string[],
  ownedPaths: readonly string[],
): WorktreeSnapshotScan {
  const root = worktreeRealpathOwned(worktree, repo.root);
  let previousDestructive: string | null = null;
  for (const path of destructiveRoots) {
    if (previousDestructive !== null && pathDescendsFrom(path, previousDestructive)) continue;
    previousDestructive = path;
  }
  const absoluteToRelative = new Map<string, string>();
  const absoluteDestructive: string[] = [];
  const exactOwned = new Set<string>();
  let lastAbsolute: string | null = null;
  for (const spec of specs) {
    const absolute = joinPath(root, spec.path);
    absoluteToRelative.set(absolute, spec.path);
    lastAbsolute = absolute;
  }
  previousDestructive = null;
  for (const path of destructiveRoots) {
    if (previousDestructive !== null && pathDescendsFrom(path, previousDestructive)) continue;
    previousDestructive = path;
    absoluteDestructive.push(joinPath(root, path));
  }
  absoluteDestructive.sort(comparePaths);
  for (const path of ownedPaths) exactOwned.add(path);
  const found = new Map<string, WorktreeStat>();
  if (lastAbsolute === null) {
    return { entries: found };
  }
  let after: string | undefined;
  while (true) {
    const page = worktreeScanPageOwned(worktree, root, after);
    if (page.length === 0) {
      break;
    }
    for (const entry of page) {
      const relative = relativeTo(root, entry.path);
      if (relative === null) throw new CorruptError("worktree scan escaped the repository root");
      const exact = absoluteToRelative.get(entry.path);
      if (exact !== undefined && !found.has(exact)) {
        found.set(exact, entry);
      }
      const owner = destructiveOwner(entry.path, absoluteDestructive);
      if (
        owner !== null &&
        entry.path !== owner &&
        !ownedPathOrAncestor(relative, ownedPaths, exactOwned)
      ) {
        throw new GitError(
          "ECHECKOUTFAIL",
          `working tree path blocks merge restoration: ${relative}`,
        );
      }
      if (comparePaths(entry.path, lastAbsolute) > 0 && owner === null) break;
    }
    const tail = page[page.length - 1];
    const finished = tail === undefined || page.length < APPLY_SCAN_PAGE;
    if (tail !== undefined && after !== undefined && comparePaths(tail.path, after) <= 0) {
      throw new CorruptError("merge worktree scan cursor made no progress");
    }
    const beyondOwned =
      tail !== undefined &&
      comparePaths(tail.path, lastAbsolute) > 0 &&
      destructiveOwner(tail.path, absoluteDestructive) === null;
    if (!finished && !beyondOwned && tail !== undefined) {
      after = tail.path;
    }
    if (finished || beyondOwned) break;
  }
  return { entries: found };
}

export function indexSnapshots(repo: Repository, specs: readonly TouchedSpec[]): IndexSnapshots {
  const wanted = new Set<string>();
  const found = new Map<string, MergeIndexSnapshot>();
  for (const spec of specs) wanted.add(spec.path);
  const last = specs[specs.length - 1];
  if (last === undefined) return { entries: found };
  for (const entry of indexScanOwned(repo.checkout)) {
    if (comparePaths(entry.path, last.path) > 0) break;
    if (!wanted.has(entry.path)) continue;
    if (entry.stage !== 0) {
      throw new GitError("EUNMERGED", "cannot apply a merge over unmerged index entries");
    }
    found.set(entry.path, {
      stage: 0,
      mode: entry.mode,
      oid: entry.oid,
      size: entry.size,
      mtime: entry.mtime,
      ino: entry.ino,
      rev: entry.rev ?? null,
    });
  }
  return { entries: found };
}

export function snapshotWorktreeObjects(
  repo: Repository,
  worktree: Worktree,
  drafts: readonly SnapshotDraft[],
): SnapshotObjects {
  const paths: { path: string; stat: WorktreeStat }[] = [];
  for (const draft of drafts) {
    const stat = draft.stat;
    if (stat?.type === "symlink") {
      if (stat.target === null) {
        throw new CorruptError(`worktree symlink ${draft.spec.path} has no target`);
      }
      validateCanonicalUtf16(stat.target, `merge snapshot symlink ${draft.spec.path}`);
    }
    if (stat?.type === "file" || stat?.type === "symlink") {
      paths.push({ path: draft.spec.path, stat });
    }
  }
  const hashed = hashExactWorktreePathsOwned(repo, worktree, paths, {
    write: true,
  });
  for (const draft of drafts) {
    if (
      (draft.stat?.type === "file" || draft.stat?.type === "symlink") &&
      !hashed.has(draft.spec.path)
    ) {
      throw new CorruptError(`merge snapshot lost worktree path ${draft.spec.path}`);
    }
  }
  return { entries: hashed };
}

function worktreeSnapshot(draft: SnapshotDraft, oid: string | undefined): MergeWorktreeSnapshot {
  const stat = draft.stat;
  if (stat === null) return { kind: "absent" };
  if (stat.type === "dir") return { kind: "directory", mode: stat.mode, revision: stat.rev };
  if (oid === undefined) throw new CorruptError(`merge snapshot lacks object ${draft.spec.path}`);
  return { kind: stat.type, mode: stat.mode, oid, revision: stat.rev };
}

export function touchedFromDrafts(
  drafts: readonly SnapshotDraft[],
  snapshots: ReadonlyMap<string, HashedPath> | null,
): MergeTouchedPath[] {
  return drafts.map((draft) => ({
    path: draft.spec.path,
    logicalPath: draft.spec.logicalPath,
    purpose: draft.spec.purpose,
    index: draft.index,
    worktree: worktreeSnapshot(
      draft,
      snapshots === null ? "0".repeat(40) : snapshots.get(draft.spec.path)?.oid,
    ),
  }));
}
