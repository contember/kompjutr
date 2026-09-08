import { CorruptError } from "../../common/errors.js";
import type { BlobIdMapping, IndexEntry } from "../../store/index.js";
import { sharedRepoStoreMutations } from "../../store/repository/shared.js";
import type { Repository } from "../repository/repository.js";
import type { TargetEntry } from "../tree/tree-stream.js";
import { gitModeFor, type Worktree } from "../worktree/worktree.js";
import {
  hashExactWorktreePaths,
  hashWorktreePathsOwned,
  indexMatchesStat,
  type WorktreeHashCursor,
  type WorktreePath,
} from "../worktree/worktree-io.js";
import {
  compareIdentities,
  type EndpointIdentity,
  type PendingChange,
  treeIdentity,
  type WorkingCandidate,
} from "./diff-internal.js";

export function indexTarget(entry: IndexEntry): TargetEntry {
  return { path: entry.path, mode: entry.mode.toString(8).padStart(6, "0"), oid: entry.oid };
}

export function* resolveWorkingCandidateIdentities(
  repo: Repository,
  worktree: Worktree,
  candidates: WorkingCandidate[],
  exact = false,
  renameCandidatesOnly = false,
  hashCursor?: WorktreeHashCursor,
): Generator<PendingChange> {
  if (candidates.length === 0) return;
  const sourceRows = candidates.splice(0);
  const rows = renameCandidatesOnly
    ? sourceRows.filter((row) => {
        const worktreePresent = row.worktree !== undefined && row.worktree.stat.type !== "dir";
        return (row.before === undefined) !== !worktreePresent;
      })
    : sourceRows;
  if (rows.length === 0) return;
  const afters = resolveWorkingCandidateAfters(repo, worktree, rows, exact, hashCursor);
  for (const row of rows) {
    const after = afters.get(row.path);
    if (after === undefined) throw new CorruptError("diff lost a working-tree identity");
    const change = compareIdentities(row.path, treeIdentity(row.before), after);
    if (
      change !== null &&
      (!renameCandidatesOnly || (change.before === null) !== (change.after === null))
    ) {
      yield change;
    }
  }
}

export function resolveWorkingCandidateAfters(
  repo: Repository,
  worktree: Worktree,
  rows: readonly WorkingCandidate[],
  exact: boolean,
  hashCursor?: WorktreeHashCursor,
): Map<string, EndpointIdentity | null> {
  const expected: BlobIdMapping[] = [];
  for (const row of rows) {
    const mapping = expectedWorktreeMapping(row);
    if (mapping !== null) expected.push(mapping);
  }
  const mismatches = repo.store.blobIdMismatches(expected);
  const unresolved: WorktreePath[] = [];
  const mapped = new Map<string, string>();
  let expectedOrdinal = 0;
  for (const row of rows) {
    if (cachedWorktreeOid(row.index, row.worktree) !== null) continue;
    const mapping = expectedWorktreeMapping(row);
    const mismatch = mapping === null ? null : mismatches.get(expectedOrdinal);
    const oid =
      mapping === null
        ? undefined
        : mismatches.has(expectedOrdinal)
          ? (mismatch ?? undefined)
          : mapping.oid;
    if (mapping !== null) expectedOrdinal++;
    if (oid !== undefined) mapped.set(row.path, oid);
    else if (row.worktree !== undefined && row.worktree.stat.type !== "dir") {
      unresolved.push(row.worktree);
    }
  }
  const hashes = exact
    ? hashExactWorktreePaths(repo, worktree, unresolved, { write: false })
    : hashWorktreePathsOwned(repo, worktree, unresolved, { write: false }, hashCursor);
  sharedRepoStoreMutations(repo.store).upsertBlobIdsOwned(
    [...hashes.values()].flatMap((hashed) => {
      const contentId = hashed.stat.contentId;
      return contentId === null ? [] : [{ contentId, oid: hashed.oid }];
    }),
  );

  const afters = new Map<string, EndpointIdentity | null>();
  for (const row of rows) {
    const cached = cachedWorktreeOid(row.index, row.worktree);
    const hashed = hashes.get(row.path);
    const oid = cached ?? mapped.get(row.path) ?? hashed?.oid;
    const after =
      oid === undefined || row.worktree === undefined || row.worktree.stat.type === "dir"
        ? null
        : {
            mode: hashed?.mode ?? gitModeFor(row.worktree.stat),
            oid,
            worktree: row.worktree,
          };
    afters.set(row.path, after);
  }
  return afters;
}

function expectedWorktreeOid(row: WorkingCandidate): string | undefined {
  return row.index?.oid ?? row.before?.oid;
}

function expectedWorktreeMapping(row: WorkingCandidate): BlobIdMapping | null {
  if (cachedWorktreeOid(row.index, row.worktree) !== null) return null;
  const contentId = row.worktree?.stat.contentId;
  const oid = expectedWorktreeOid(row);
  return contentId === null || contentId === undefined || oid === undefined
    ? null
    : { contentId, oid };
}

function cachedWorktreeOid(
  entry: IndexEntry | undefined,
  worktree: WorktreePath | undefined,
): string | null {
  if (entry === undefined || worktree === undefined || worktree.stat.type === "dir") return null;
  return indexMatchesStat(entry, worktree.stat) ? entry.oid : null;
}
