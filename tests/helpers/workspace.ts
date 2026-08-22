import type { GitContext } from "../../src/core/context.js";
import { initRepository } from "../../src/core/ops/init.js";
import type { Repository } from "../../src/core/repository.js";
import { NodeFsCompat } from "../../src/fs/compat/node.js";
import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem } from "../../src/fs/types.js";
import { initializeIndexTracker } from "../../src/sqlite/index-tracker.js";
import { createSqliteSparseWorkspaceSource } from "../../src/sqlite/sparse-workspace.js";
import { SqliteGitDatabase, type StoreOptions } from "../../src/sqlite/store.js";
import { TestDatabase } from "./db.js";
import { SqliteTestStorage } from "./storage.js";

export interface TestWorkspace {
  storage: SqliteTestStorage;
  workspace: { fs: NodeFsCompat };
  worktree: Filesystem;
  database: SqliteGitDatabase;
  context: GitContext;
  /** Advance the fixed clock, in milliseconds. */
  tick(ms: number): void;
}

export interface MakeWorkspaceOptions extends StoreOptions {
  /** Fixed epoch milliseconds the clock starts at. */
  startTime?: number;
  /** Minutes west of UTC for commit timestamps. UTC by default. */
  timezoneOffset?: number;
}

export function makeWorkspace(options: MakeWorkspaceOptions = {}): TestWorkspace {
  const storage = new SqliteTestStorage();
  let clock = options.startTime ?? 1_577_836_800_000; // 2020-01-01T00:00:00Z
  const now = (): number => clock;
  const db = new TestDatabase(storage);
  const worktree = createFilesystem(db, { now });
  const workspace = { fs: new NodeFsCompat(worktree) };
  const database = new SqliteGitDatabase(db, options);
  initializeIndexTracker(db);
  const context: GitContext = {
    database,
    worktree,
    sparseWorkspace: createSqliteSparseWorkspaceSource(db),
    now,
    timezoneOffset: () => options.timezoneOffset ?? 0,
  };
  return {
    storage,
    workspace,
    worktree,
    database,
    context,
    tick(ms) {
      clock += ms;
    },
  };
}

export interface TestRepository extends TestWorkspace {
  repo: Repository;
}

/** A workspace with one initialised repository at `root`. */
export function makeRepo(root = "/", options: MakeWorkspaceOptions = {}): TestRepository {
  const workspace = makeWorkspace(options);
  const repo = initRepository(workspace.context, { dir: root });
  return { ...workspace, repo };
}

/** Write a working-tree file through DOFS, creating parents as needed. */
export function writeWorkFile(
  workspace: TestWorkspace,
  path: string,
  content: string,
  mode = 0o644,
): void {
  workspace.worktree.writeFiles([{ path, bytes: new TextEncoder().encode(content), mode }]);
}
