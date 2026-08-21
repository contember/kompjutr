// The Computer-facing surface: one `GitClient` bound to one Workspace.
//
// This file is the only place that knows both worlds. It resolves a `dir`
// to a repository, hands the ops what they need, and returns the shapes
// Computer's interface declares. The ops themselves have never heard of
// Computer.

import type { SQLiteWorkspaceProvider } from "@cloudflare/computer";
import type {
  GitClient,
  GitClientFactory,
  WorkspaceGitClientOptions,
} from "@cloudflare/computer/git";

import { type GitContext, type GitIdentity, nestedRoots, openRepository } from "../core/context.js";
import { UnsupportedOperationError } from "../core/errors.js";
import { commit as commitOp } from "../core/ops/commit.js";
import { configGet, configSet, remoteAdd, remoteList, remoteRemove } from "../core/ops/config.js";
import { diff as diffOp, diffSummary as diffSummaryOp } from "../core/ops/diff.js";
import { initRepository } from "../core/ops/init.js";
import { clone as cloneOp, fetchInto } from "../core/ops/network.js";
import {
  catFile as catFileOp,
  hashObject as hashObjectOp,
  repoRoot as repoRootOp,
  updateRef as updateRefOp,
} from "../core/ops/plumbing.js";
import {
  catFile as catFileRead,
  log as logOp,
  lsFilesAtRef,
  lsTree as lsTreeOp,
  show as showOp,
} from "../core/ops/reads.js";
import {
  branchDelete as branchDeleteOp,
  branchList as branchListOp,
  branch as branchOp,
  checkout as checkoutOp,
  currentBranch as currentBranchOp,
  tagDelete as tagDeleteOp,
  tagList as tagListOp,
  tag as tagOp,
} from "../core/ops/refs.js";
import {
  add as addOp,
  lsFiles as lsFilesOp,
  reset as resetOp,
  rm as rmOp,
} from "../core/ops/staging.js";
import { clean as cleanOp, status as statusOp } from "../core/ops/status.js";
import type { Repository } from "../core/repository.js";
import { iterateSqlCursor, type SqlDatabase } from "../sqlite/db.js";
import { SqliteGitDatabase, type StoreOptions } from "../sqlite/store.js";
import { ComputerWorktree } from "./worktree.js";

export interface CreateSqliteGitClientOptions extends StoreOptions {
  /** Clock for commit timestamps and pack metadata. Defaults to `Date.now`. */
  now?: () => number;
  /** Minutes west of UTC for commit timestamps. Defaults to UTC. */
  timezoneOffset?: () => number;
  /**
   * Awaited during long pack ingest loops so the runtime can flush its
   * write buffer. A Durable Object holds a request's dirty pages in the
   * isolate heap, so a long clone needs somewhere to breathe.
   */
  yieldNow?: () => Promise<void>;
}

/**
 * Build a `WorkspaceOptions.git` factory backed by SQLite.
 *
 * ```ts
 * const ws = new Workspace({ storage: ctx.storage, git: createSqliteGitClient() });
 * ```
 */
export function createSqliteGitClient(
  options: CreateSqliteGitClientOptions = {},
): GitClientFactory {
  return function createWorkspaceGitClient({
    ws,
    defaultIdentity,
  }: WorkspaceGitClientOptions): GitClient {
    let context: GitContext | undefined;
    // The provider is stable for the workspace's lifetime, but building the
    // database runs the schema migration, so it waits for first use.
    const ctx = (): GitContext => {
      if (context === undefined) context = buildContext(ws.provider(), options, defaultIdentity);
      return context;
    };
    const at = (dir?: string): Repository => openRepository(ctx(), dir ?? "/");
    const excludeRoots = (repo: Repository): string[] => nestedRoots(ctx(), repo.root);

    const client: GitClient = {
      async clone(input) {
        await cloneOp(ctx(), input);
      },
      async fetch(input = {}) {
        return fetchInto(ctx(), at(input.dir), input);
      },
      async init(input = {}) {
        initRepository(ctx(), input);
      },

      async status(input = {}) {
        const repo = at(input.dir);
        const rows = statusOp(repo, ctx().worktree, { excludeRoots: excludeRoots(repo) });
        // Projected to exactly what the interface declares. StatusDetail is
        // a superset, and handing it back would be a silent shape change
        // for anyone comparing or serialising the result. Callers wanting
        // the modes and oids use the `status` op directly.
        return rows.map((row) => ({ path: row.path, index: row.index, worktree: row.worktree }));
      },
      async diff(input = {}) {
        return diffOp(at(input.dir), ctx().worktree, input);
      },
      async diffSummary(input = {}) {
        return diffSummaryOp(at(input.dir), ctx().worktree, input);
      },
      async clean(input = {}) {
        const repo = at(input.dir);
        return cleanOp(repo, ctx().worktree, { ...input, excludeRoots: excludeRoots(repo) });
      },

      async add(input) {
        const repo = at(input.dir);
        addOp(repo, ctx().worktree, { ...input, excludeRoots: excludeRoots(repo) });
      },
      async rm(input) {
        rmOp(at(input.dir), ctx().worktree, input);
      },
      async reset(input = {}) {
        resetOp(at(input.dir), ctx().worktree, input);
      },
      async commit(input) {
        return commitOp(ctx(), at(input.dir), input);
      },

      async log(input = {}) {
        return logOp(at(input.dir), input);
      },
      async show(input) {
        return showOp(at(input.dir), input.ref);
      },
      async revParse(input) {
        return at(input.dir).revParse(input.ref);
      },
      async repoRoot(input = {}) {
        return repoRootOp(ctx(), input);
      },
      async currentBranch(input = {}) {
        return currentBranchOp(at(input.dir), input);
      },
      async lsFiles(input = {}) {
        const repo = at(input.dir);
        return input.ref === undefined ? lsFilesOp(repo) : lsFilesAtRef(repo, input.ref);
      },
      async lsTree(input) {
        return lsTreeOp(at(input.dir), input.ref, input.path);
      },

      async branch(input) {
        branchOp(at(input.dir), input);
      },
      async branchDelete(input) {
        branchDeleteOp(at(input.dir), input);
      },
      async branchList(input = {}) {
        return branchListOp(at(input.dir));
      },
      async tag(input) {
        tagOp(at(input.dir), input);
      },
      async tagDelete(input) {
        tagDeleteOp(at(input.dir), input);
      },
      async tagList(input = {}) {
        return tagListOp(at(input.dir));
      },
      async checkout(input) {
        checkoutOp(ctx(), at(input.dir), ctx().worktree, input);
      },

      async remoteAdd(input) {
        remoteAdd(at(input.dir), input);
      },
      async remoteRemove(input) {
        remoteRemove(at(input.dir), input);
      },
      async remoteList(input = {}) {
        return remoteList(at(input.dir));
      },
      async configGet(input) {
        return configGet(at(input.dir), input);
      },
      async configSet(input) {
        configSet(at(input.dir), input);
      },

      async hashObject(input) {
        return hashObjectOp(at(input.dir), input);
      },
      async catFile(input) {
        const repo = at(input.dir);
        // The `<oid>:<path>` shorthand only has a meaning with a ref on the
        // left, which the reads layer already resolves.
        return input.filepath === undefined
          ? catFileOp(repo, input)
          : catFileRead(repo, input.oid, input.filepath);
      },
      async updateRef(input) {
        updateRefOp(at(input.dir), input);
      },

      // Phase 5 and beyond. The object satisfies the interface so a caller
      // can bind it today and find out precisely what is missing.
      async push() {
        throw new UnsupportedOperationError("push");
      },
      async pull() {
        throw new UnsupportedOperationError("pull");
      },
      async merge() {
        throw new UnsupportedOperationError("merge");
      },
      async stashPush() {
        throw new UnsupportedOperationError("stash push");
      },
      async stashList() {
        throw new UnsupportedOperationError("stash list");
      },
      async stashPop() {
        throw new UnsupportedOperationError("stash pop");
      },
      async cli() {
        throw new UnsupportedOperationError("the argv entry point");
      },
    };
    return client;
  };
}

function buildContext(
  provider: SQLiteWorkspaceProvider,
  options: CreateSqliteGitClientOptions,
  defaultIdentity: GitIdentity | undefined,
): GitContext {
  const computerDb = provider.db;
  const db: SqlDatabase = {
    run(query, ...bindings) {
      computerDb.run(query, ...bindings);
    },
    all(query, ...bindings) {
      return computerDb.all(query, ...bindings);
    },
    one(query, ...bindings) {
      return computerDb.one(query, ...bindings);
    },
    scalar(query, ...bindings) {
      return computerDb.scalar(query, ...bindings);
    },
    iterate(query, ...bindings) {
      return iterateSqlCursor(computerDb.sql.exec(query, ...bindings));
    },
    transactionSync(closure) {
      return computerDb.transactionSync(closure);
    },
  };
  const context: GitContext = {
    database: new SqliteGitDatabase(db, options),
    worktree: new ComputerWorktree(provider),
    now: options.now ?? Date.now,
    timezoneOffset: options.timezoneOffset ?? (() => 0),
  };
  if (defaultIdentity !== undefined) context.defaultIdentity = defaultIdentity;
  if (options.yieldNow !== undefined) context.yieldNow = options.yieldNow;
  return context;
}
