import type { GitIdentity } from "../core/context.js";
import type { GitHttpClient } from "../core/protocol/transport.js";
import { NodeFsCompat } from "../fs/compat/node.js";
import { createFilesystem } from "../fs/filesystem.js";
import { createInitialWorktreeWriter } from "../fs/store/initial-write.js";
import type { Filesystem } from "../fs/types.js";
import type { Git, GitFactory } from "../git/client.js";
import { Database, type DurableObjectStorageLike } from "../sqlite/db.js";
import { initializeIndexTracker } from "../sqlite/index-tracker.js";
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
      const binding = {
        database: this.#gitDatabase,
        worktree: this.filesystem,
        initialWorktree: createInitialWorktreeWriter(this.db, now),
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
