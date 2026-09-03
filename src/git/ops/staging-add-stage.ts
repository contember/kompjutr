import { GitError } from "../common/errors.js";
import { contentIdKey, type IndexEntry, type IndexSink } from "../store/index.js";
import { sharedRepoStoreMutations } from "../store/shared.js";
import type { Repository } from "./repository.js";
import type { TargetEntry } from "./tree-stream.js";
import { gitModeFor, type Worktree } from "./worktree.js";
import {
  type CompiledPathspecMatcher,
  hashWorktreePathsOwned,
  indexEntryFor,
  indexMatchesStat,
  type WorktreeHashCursor,
  type WorktreePath,
} from "./worktree-io.js";

const ADD_MAX_ROWS_PER_STREAM = 50_000;

export interface AddIndexPath {
  path: string;
  entry: IndexEntry | undefined;
  conflicted: boolean;
}

export interface AddIndexSnapshot {
  paths: Iterable<AddIndexPath>;
}

export interface AddOperationLimits {
  worktreeRows: number;
  headRows: number;
}

export interface StageCandidate {
  path: string;
  existing: IndexEntry | undefined;
  worktree: WorktreePath;
  conflicted: boolean;
}

export interface StageCandidateBatch {
  rows: StageCandidate[];
}

export function addIndexSource(
  entries: Iterable<IndexEntry>,
  pathspec: CompiledPathspecMatcher | undefined,
): AddIndexSnapshot {
  return { paths: groupedAddIndexRows(entries, pathspec) };
}

function* groupedAddIndexRows(
  entries: Iterable<IndexEntry>,
  pathspec: CompiledPathspecMatcher | undefined,
): Generator<AddIndexPath> {
  let current: AddIndexPath | null = null;
  for (const entry of entries) {
    if (pathspec !== undefined && !pathspec.matches(entry.path)) continue;
    if (current === null || current.path !== entry.path) {
      if (current !== null) yield current;
      current = {
        path: entry.path,
        entry: entry.stage === 0 ? entry : undefined,
        conflicted: entry.stage !== 0,
      };
    } else if (entry.stage === 0) {
      current.entry = entry;
    } else current.conflicted = true;
  }
  if (current !== null) yield current;
}

export function* boundedAddWorktreeRows(
  entries: Iterable<WorktreePath>,
  limits: AddOperationLimits,
): Generator<WorktreePath> {
  for (const entry of entries) {
    if (limits.worktreeRows >= ADD_MAX_ROWS_PER_STREAM) {
      throw new GitError("E2BIG", `add worktree scan exceeds ${ADD_MAX_ROWS_PER_STREAM} rows`);
    }
    limits.worktreeRows++;
    yield entry;
  }
}

export function* boundedAddHeadRows(
  entries: Iterable<TargetEntry>,
  limits: AddOperationLimits,
): Generator<TargetEntry> {
  for (const entry of entries) {
    if (limits.headRows >= ADD_MAX_ROWS_PER_STREAM) {
      throw new GitError("E2BIG", `add HEAD scan exceeds ${ADD_MAX_ROWS_PER_STREAM} rows`);
    }
    limits.headRows++;
    yield entry;
  }
}

export function stageCandidates(
  repo: Repository,
  worktree: Worktree,
  candidates: StageCandidateBatch,
  sink: IndexSink,
  hashCursor: WorktreeHashCursor,
): void {
  if (candidates.rows.length === 0) return;
  try {
    const rows = candidates.rows;
    const identities = repo.store.lookupBlobIds(
      rows.flatMap((row) => {
        if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat))
          return [];
        const contentId = row.worktree.stat.contentId;
        return contentId === null ? [] : [contentId];
      }),
    );
    const unresolved: WorktreePath[] = [];
    const mapped = new Map<string, string>();
    for (const row of rows) {
      if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat)) continue;
      const contentId = row.worktree.stat.contentId;
      const oid = contentId === null ? undefined : identities.get(contentIdKey(contentId));
      if (oid === undefined) {
        unresolved.push(row.worktree);
      } else {
        mapped.set(row.path, oid);
      }
    }
    const hashes = hashWorktreePathsOwned(repo, worktree, unresolved, {}, hashCursor);
    sharedRepoStoreMutations(repo.store).upsertBlobIdsOwned(
      [...hashes.values()].flatMap((hashed) => {
        const contentId = hashed.stat.contentId;
        return contentId === null ? [] : [{ contentId, oid: hashed.oid }];
      }),
    );

    for (const row of rows) {
      let update: IndexEntry | null = null;
      if (row.existing !== undefined && indexMatchesStat(row.existing, row.worktree.stat)) {
        update = indexEntryFor(row.path, {
          oid: row.existing.oid,
          mode: row.existing.mode.toString(8).padStart(6, "0"),
          stat: row.worktree.stat,
        });
      } else {
        const hashed = hashes.get(row.path);
        const oid = mapped.get(row.path);
        if (hashed !== undefined) update = indexEntryFor(row.path, hashed);
        else if (oid !== undefined) {
          update = indexEntryFor(row.path, {
            oid,
            mode: gitModeFor(row.worktree.stat),
            stat: row.worktree.stat,
          });
        }
      }
      if (update === null) {
        if (row.existing !== undefined || row.conflicted) sink.remove(row.path);
        continue;
      }
      if (row.conflicted) sink.remove(row.path);
      sink.put(update);
    }
  } finally {
    candidates.rows.length = 0;
  }
}

export function retainStageCandidate(batch: StageCandidateBatch, candidate: StageCandidate): void {
  batch.rows.push(candidate);
}
