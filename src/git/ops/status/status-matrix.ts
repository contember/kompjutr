import { GitError } from "../../common/errors.js";
import { joinPath } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import type { IndexEntry } from "../../store/index.js";
import { matchesPaths, treeEntries } from "../checkout/checkout.js";
import type { StatusRow } from "../core/kinds.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { hashWorktreePath, indexMatchesStat } from "../worktree/worktree-io.js";
import { worktreeFiles } from "./status-full.js";
import type { StatusOptions } from "./status-rows.js";
import { statusIndexGroups } from "./status-rows.js";

/** O(tracked). Only `statusMatrix`, which is not on the client surface, still needs it. */
export function stagedIndex(repo: Repository): Map<string, IndexEntry> {
  const index = new Map<string, IndexEntry>();
  for (const group of statusIndexGroups(repo.checkout.indexScan())) {
    if (group.kind === "unmerged") {
      throw new GitError("EUNMERGED", `status matrix cannot represent conflict at ${group.path}`);
    }
    index.set(group.path, group.entry);
  }
  return index;
}

// -- the isomorphic-git shape ------------------------------------------

/**
 * isomorphic-git's `statusMatrix`, for callers that already speak it. It
 * lists every file individually — no directory collapsing — and compares
 * content only, so a mode-only change is invisible here.
 */
export function statusMatrix(
  repo: Repository,
  worktree: Worktree,
  options: StatusOptions = {},
): StatusRow[] {
  const head = treeEntries(repo, repo.headTree());
  const index = stagedIndex(repo);
  const present = new Set<string>(worktreeFiles(repo, worktree, options));

  const paths = new Set<string>([...head.keys(), ...index.keys(), ...present]);
  const rows: StatusRow[] = [];
  for (const path of [...paths].sort(comparePaths)) {
    if (!matchesPaths(path, options.paths)) continue;
    const headOid = head.get(path)?.oid ?? null;
    const stageOid = index.get(path)?.oid ?? null;
    const workdirOid = worktreeOid(repo, worktree, path, index.get(path), present.has(path));
    rows.push([
      path,
      headOid === null ? 0 : 1,
      workdirOid === null ? 0 : workdirOid === headOid ? 1 : 2,
      stageOid === null ? 0 : stageOid === headOid ? 1 : stageOid === workdirOid ? 2 : 3,
    ]);
  }
  return rows;
}

function worktreeOid(
  repo: Repository,
  worktree: Worktree,
  path: string,
  entry: IndexEntry | undefined,
  present: boolean,
): string | null {
  if (!present) return null;
  if (entry !== undefined) {
    const stat = worktree.stat(joinPath(repo.root, path));
    if (stat !== null && indexMatchesStat(entry, stat)) return entry.oid;
  }
  return hashWorktreePath(repo, worktree, path, { write: false })?.oid ?? null;
}
