// kompjutr — a SQLite-native git backend for Cloudflare Computer.
//
//   const ws = new Workspace({ storage: ctx.storage, git: createSqliteGitClient() });
//
// The git database lives in the Durable Object's SQLite tables and the
// working tree in DOFS. There is no `.git` directory.

export {
  createSqliteGitClient,
  type CreateSqliteGitClientOptions,
} from "./computer/client.js";
export { ComputerWorktree } from "./computer/worktree.js";

export {
  AlreadyInitializedError,
  CorruptError,
  GitError,
  MissingIdentityError,
  NotARepositoryError,
  ObjectNotFoundError,
  PathOutsideRepoError,
  PathspecNotFoundError,
  RefNotFoundError,
  UnsupportedOperationError,
} from "./core/errors.js";

export type { GitContext, GitIdentity } from "./core/context.js";
export { findRepository, nestedRoots, openRepository } from "./core/context.js";
export { Repository } from "./core/repository.js";
export type { Worktree, WorktreeDirent, WorktreeStat } from "./core/worktree.js";

export type {
  CommitResult,
  DiffSummaryEntry,
  MergeResult,
  PushResult,
  RefUpdateStatus,
  RemoteView,
  StatusEntry,
  StatusRow,
} from "./core/ops/kinds.js";
export type { CommitView, TreeEntryView } from "./core/ops/reads.js";
export {
  formatPorcelainV1,
  formatPorcelainV2,
  formatShort,
  type StatusDetail,
} from "./core/ops/status.js";

export {
  type IndexEntry,
  type RepositoryRow,
  RepoStore,
  SqliteGitDatabase,
  type StoreOptions,
} from "./sqlite/store.js";
export { initializeGitSchema, SCHEMA_VERSION } from "./sqlite/schema.js";
export type { SqlDatabase } from "./sqlite/db.js";
