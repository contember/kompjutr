import { NotARepositoryError } from "./errors.js";
import { normalizePath } from "./paths.js";
import { Repository } from "./repository.js";
import type { Worktree } from "./worktree.js";
import type { SqliteGitDatabase } from "../sqlite/store.js";
import type { GitHttpClient } from "./protocol/transport.js";

export interface GitIdentity {
  name: string;
  email: string;
}

/** Everything the commands need that is not the repository itself. */
export interface GitContext {
  database: SqliteGitDatabase;
  worktree: Worktree;
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
