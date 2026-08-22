import type { SqliteGitDatabase } from "../sqlite/store.js";
import { NotARepositoryError } from "./errors.js";
import { normalizePath } from "./paths.js";
import type { GitHttpClient } from "./protocol/transport.js";
import { Repository } from "./repository.js";
import type { Worktree } from "./worktree.js";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface InitialWorktreeWriteOptions {
  mode?: number;
  contentId?: Uint8Array;
}

export interface InitialWorktreeSymlinkOptions {
  mode?: number;
  contentId?: Uint8Array;
}

export interface InitialWorktreeSession {
  writeSymlink(path: string, target: string, options?: InitialWorktreeSymlinkOptions): void;
  writeFile(path: string, bytes: Uint8Array, options?: InitialWorktreeWriteOptions): void;
  writeFileStream(
    path: string,
    size: number,
    chunks: Iterable<Uint8Array>,
    options?: InitialWorktreeWriteOptions,
  ): void;
}

export type InitialWorktreeResult<T> = { kind: "committed"; value: T } | { kind: "unavailable" };

/** Optional clone-only bulk writer. Core depends only on this structural seam. */
export interface InitialWorktreeWriter {
  tryRun<T>(
    root: string,
    body: (session: InitialWorktreeSession) => T,
    afterClose?: (value: T) => unknown,
  ): InitialWorktreeResult<T>;
}

export interface IndexTrackerSeedEntry {
  path: string;
  flags: number;
}

/** Optional sparse-state writer. Core supplies bounded, complete snapshots only. */
export interface IndexTrackerWriter {
  reseal(
    repoId: number,
    baselineTreeOid: string | null,
    entries: Iterable<IndexTrackerSeedEntry>,
  ): boolean;
}

/** Everything the commands need that is not the repository itself. */
export interface GitContext {
  database: SqliteGitDatabase;
  worktree: Worktree;
  initialWorktree?: InitialWorktreeWriter;
  indexTracker?: IndexTrackerWriter;
  http?: GitHttpClient;
  now: () => number;
  /** Minutes west of UTC, for commit timestamps. */
  timezoneOffset: () => number;
  defaultIdentity?: GitIdentity;
  /** Awaited during long ingest loops so the runtime can flush writes. */
  yieldNow?: () => Promise<void>;
}

export function openRepository(context: GitContext, dir = "/"): Repository {
  const row = context.database.find(normalizePath(dir));
  if (row === null) throw new NotARepositoryError(normalizePath(dir));
  return new Repository(context.database.open(row), row.root);
}

export function findRepository(context: GitContext, dir = "/"): Repository | null {
  const row = context.database.find(normalizePath(dir));
  return row === null ? null : new Repository(context.database.open(row), row.root);
}

/**
 * Roots of other repositories nested inside `root`. Their files belong to
 * them, so a working-tree walk has to stop there — the one thing a `.git`
 * directory used to signal for free.
 */
export function nestedRoots(context: GitContext, root: string): string[] {
  const base = normalizePath(root);
  const prefix = base === "/" ? "/" : `${base}/`;
  return context.database
    .list()
    .map((row) => row.root)
    .filter((candidate) => candidate !== base && candidate.startsWith(prefix));
}
