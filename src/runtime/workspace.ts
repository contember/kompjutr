import type { GitIdentity, IndexTrackerWriter } from "../core/context.js";
import type { GitHttpClient } from "../core/protocol/transport.js";
import { NodeFsCompat } from "../fs/compat/node.js";
import { createExactPathStateSource } from "../fs/exact-path-states.js";
import { createFilesystem } from "../fs/filesystem.js";
import { createInitialWorktreeWriter } from "../fs/store/initial-write.js";
import type { Filesystem } from "../fs/types.js";
import type { Git, GitFactory } from "../git/client.js";
import { Database, type DurableObjectStorageLike } from "../sqlite/db.js";
import {
  advanceIndexTrackerBaseline,
  initializeIndexTracker,
  resealIndexTracker,
} from "../sqlite/index-tracker.js";
import {
  createSqliteCommitTreeSnapshotSource,
  createSqliteSelectedPathSource,
  createSqliteSparseWorkspaceSource,
} from "../sqlite/sparse-workspace.js";
import { SqliteGitDatabase, type StoreOptions } from "../sqlite/store.js";
import type { ProcessExecOptions, ProcessHandle, ProcessHost } from "./types.js";

export interface WorkspaceOptions extends StoreOptions {
  storage: DurableObjectStorageLike;
  git?: GitFactory;
  processHost?: ProcessHost;
  defaultGitIdentity?: GitIdentity;
  timezoneOffset?: () => number;
  http?: GitHttpClient;
  yieldNow?: () => Promise<void>;
}

/** One SQLite-backed filesystem and Git runtime. */
export class Workspace {
  readonly db: Database;
  readonly filesystem: Filesystem;
  readonly fs: NodeFsCompat;

  readonly #options: WorkspaceOptions;
  #gitDatabase: SqliteGitDatabase | undefined;
  #git: Git | undefined;

  constructor(options: WorkspaceOptions) {
    this.#options = options;
    this.db = new Database(options.storage);
    const now = options.now ?? Date.now;
    this.filesystem = createFilesystem(this.db, { now });
    this.fs = new NodeFsCompat(this.filesystem);
  }

  get git(): Git {
    const factory = this.#options.git;
    if (factory === undefined) {
      throw new Error(
        "Workspace git is not configured. Import createGit from kompjutr/git and pass createGit() as WorkspaceOptions.git.",
      );
    }
    if (this.#git === undefined) {
      this.#gitDatabase = new SqliteGitDatabase(this.db, this.#options);
      initializeIndexTracker(this.db);
      const now = this.#options.now ?? Date.now;
      const indexTracker: IndexTrackerWriter = {
        reseal: (checkoutId, baselineTreeOid, entries, owningReservation) =>
          resealIndexTracker(this.db, checkoutId, baselineTreeOid, entries, owningReservation),
        advanceBaseline: (checkoutId, baselineTreeOid) =>
          advanceIndexTrackerBaseline(this.db, checkoutId, baselineTreeOid),
      };
      const initialWorktree = createInitialWorktreeWriter(
        this.db,
        now,
        (database) => database === this.#gitDatabase,
      );
      const binding = {
        database: this.#gitDatabase,
        worktree: this.filesystem,
        exactRootStates: createExactPathStateSource(this.db),
        initialWorktree,
        indexTracker,
        sparseWorkspace: createSqliteSparseWorkspaceSource(this.db),
        selectedPaths: createSqliteSelectedPathSource(this.db),
        commitTrees: createSqliteCommitTreeSnapshotSource(this.db),
        now,
        timezoneOffset: this.#options.timezoneOffset ?? (() => 0),
        defaultIdentity: this.#options.defaultGitIdentity,
        http: this.#options.http,
        yieldNow: this.#options.yieldNow,
      };
      this.#git = factory(binding);
    }
    return this.#git;
  }

  exec(command: string, options?: ProcessExecOptions): Promise<ProcessHandle> {
    const host = this.#options.processHost;
    if (host === undefined) throw new Error("Workspace exec is not configured");
    return host.exec(command, options);
  }
}
