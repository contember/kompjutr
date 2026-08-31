import { NotARepositoryError } from "../common/errors.js";
import { normalizePath } from "../common/paths.js";
import type { GitHttpClient } from "../protocol/transport.js";
import type { SqliteGitDatabase } from "../store/index.js";
import { Repository } from "./repository.js";
import type {
  CommitTreeSnapshotSource,
  SelectedPathSource,
  SparseWorkspaceSource,
} from "./sparse-workspace.js";
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

/** Optional create-only bulk writer shared by clone and eligible first checkout. */
export interface InitialWorktreeWriter {
  /** True only when writes share the supplied native Git database transaction. */
  supportsDatabase?(database: SqliteGitDatabase): boolean;
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
    checkoutId: number,
    baselineTreeOid: string | null,
    entries: Iterable<IndexTrackerSeedEntry>,
  ): boolean;
  /** Move a sealed baseline without clearing its dirty journal. */
  advanceBaseline?(checkoutId: number, baselineTreeOid: string | null): boolean;
}

export type ExactRootState = "present" | "missing";

/** Optional bulk path-state capability used by repository checkout lifecycle operations. */
export interface ExactRootStateSource {
  states(roots: readonly string[]): readonly ExactRootState[];
}

/** Everything the commands need that is not the repository itself. */
export interface GitContext {
  database: SqliteGitDatabase;
  worktree: Worktree;
  exactRootStates?: ExactRootStateSource;
  initialWorktree?: InitialWorktreeWriter;
  indexTracker?: IndexTrackerWriter;
  sparseWorkspace?: SparseWorkspaceSource;
  selectedPaths?: SelectedPathSource;
  commitTrees?: CommitTreeSnapshotSource;
  http?: GitHttpClient;
  now: () => number;
  /** Minutes west of UTC, for commit timestamps. */
  timezoneOffset: () => number;
  defaultIdentity?: GitIdentity;
  /** Awaited during long ingest loops so the runtime can flush writes. */
  yieldNow?: () => Promise<void>;
}

export function openRepository(context: GitContext, dir = "/"): Repository {
  const row = context.database.findCheckout(normalizePath(dir));
  if (row === null) throw new NotARepositoryError(normalizePath(dir));
  return new Repository(context.database.openCheckout(row));
}

export function findRepository(context: GitContext, dir = "/"): Repository | null {
  const row = context.database.findCheckout(normalizePath(dir));
  return row === null ? null : new Repository(context.database.openCheckout(row));
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
    .listRoutingRoots()
    .filter((candidate) => candidate !== base && candidate.startsWith(prefix));
}
