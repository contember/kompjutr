// A real Computer Workspace over node:sqlite, so op tests exercise the
// same path production does: DOFS for the working tree, the Durable
// Object database for everything else.

import { Workspace } from "@cloudflare/computer";

import { ComputerWorktree } from "../../src/computer/worktree.js";
import type { GitContext } from "../../src/core/context.js";
import { initRepository } from "../../src/core/ops/init.js";
import type { Repository } from "../../src/core/repository.js";
import { SqliteGitDatabase, type StoreOptions } from "../../src/sqlite/store.js";
import { SqliteTestStorage } from "./storage.js";

export interface TestWorkspace {
  storage: SqliteTestStorage;
  workspace: Workspace;
  worktree: ComputerWorktree;
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
  const workspace = new Workspace({ storage, now });
  const provider = workspace.provider();
  const worktree = new ComputerWorktree(provider);
  const database = new SqliteGitDatabase(provider.db, options);
  const context: GitContext = {
    database,
    worktree,
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
  workspace.worktree.writeFile(path, new TextEncoder().encode(content), mode);
}
