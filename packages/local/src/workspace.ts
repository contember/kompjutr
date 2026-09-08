import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  createGit,
  type Git,
  type GitCliNetworkBinding,
  type GitFactory,
  type GitHttpClient,
  type GitIdentity,
  type GitPromisorAuth,
  SqliteGitDatabase,
  type StoreOptions,
} from "@kompjutr/git";
import { DiskDrive } from "./drive/disk-drive.js";
import { errorCode, localError } from "./errors.js";
import { PathMapper, pathsOverlap, requireCanonicalAbsolutePath } from "./paths.js";
import type { RecoveryCheckpointHandler } from "./recovery/contracts.js";
import { RecoveryCoordinator } from "./recovery/coordinator.js";
import { NodeSqliteDatabase } from "./sqlite/database.js";
import { ObservationClock } from "./sqlite/observations.js";
import { ProcessLock } from "./sqlite/process-lock.js";
import { bindRecoveryOwner } from "./sqlite/recovery-owner.js";

function canonicalDirectory(path: string, label: string): string {
  requireCanonicalAbsolutePath(path, label);
  let ancestor = path;
  let canonicalAncestor: string;
  for (;;) {
    try {
      canonicalAncestor = realpathSync.native(ancestor);
      break;
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
        ancestor = dirname(ancestor);
        continue;
      }
      throw error;
    }
  }
  if (resolve(canonicalAncestor, relative(ancestor, path)) !== path) {
    throw localError("EINVAL", `${label} must not traverse a symbolic link`, path);
  }
  let current = ancestor;
  for (const segment of relative(ancestor, path)
    .split("/")
    .filter((part) => part !== "")) {
    const parent = current;
    current = join(parent, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (!lstatSync(current).isDirectory()) {
      throw localError("ENOTDIR", `${label} component is not a directory`, current);
    }
    syncDirectory(current);
    syncDirectory(parent);
  }
  const canonical = realpathSync.native(path);
  if (canonical !== path) throw localError("EINVAL", `${label} must already be canonical`, path);
  if (!lstatSync(path).isDirectory())
    throw localError("ENOTDIR", `${label} is not a directory`, path);
  return canonical;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sameDirectory(left: string, right: string): boolean {
  const leftStat = lstatSync(left);
  const rightStat = lstatSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

function defaultRecoveryDirectory(root: string, stateDirectory: string): string {
  if (root === "/") throw localError("EINVAL", "workspace root cannot be the host filesystem root");
  const identity = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 12);
  return join(dirname(root), `.${basename(root)}.kompjutr-recovery-${identity}`);
}

function rootLockPath(root: string): string {
  const identity = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return join(dirname(root), `.kompjutr-lock-${identity}.sqlite`);
}

export interface LocalWorkspaceOptions extends StoreOptions {
  readonly root: string;
  readonly stateDirectory: string;
  readonly recoveryDirectory?: string;
  readonly git?: GitFactory;
  readonly defaultGitIdentity?: GitIdentity;
  readonly timezoneOffset?: () => number;
  readonly http?: GitHttpClient;
  readonly promisorAuth?: GitPromisorAuth;
  readonly promisorHeaders?: Record<string, string>;
  readonly cliNetwork?: GitCliNetworkBinding;
  readonly yieldNow?: () => Promise<void>;
  readonly recoveryCheckpoint?: RecoveryCheckpointHandler;
}

export class LocalWorkspace {
  readonly root: string;
  readonly stateDirectory: string;
  readonly recoveryDirectory: string;
  readonly database: NodeSqliteDatabase;
  readonly gitDatabase: SqliteGitDatabase;
  readonly drive: DiskDrive;
  readonly git: Git;
  readonly #lock: ProcessLock;
  #closed = false;

  constructor(options: LocalWorkspaceOptions) {
    const mapper = new PathMapper(options.root);
    requireCanonicalAbsolutePath(options.stateDirectory, "stateDirectory");
    if (pathsOverlap(mapper.root, options.stateDirectory)) {
      throw localError("EINVAL", "stateDirectory and root must not overlap");
    }
    const stateDirectory = canonicalDirectory(options.stateDirectory, "stateDirectory");
    if (sameDirectory(mapper.root, stateDirectory)) {
      throw localError("EINVAL", "stateDirectory must not alias root");
    }
    const recoveryInput =
      options.recoveryDirectory ?? defaultRecoveryDirectory(mapper.root, stateDirectory);
    requireCanonicalAbsolutePath(recoveryInput, "recoveryDirectory");
    if (pathsOverlap(mapper.root, recoveryInput) || pathsOverlap(stateDirectory, recoveryInput)) {
      throw localError("EINVAL", "recoveryDirectory must not overlap root or stateDirectory");
    }
    const recoveryDirectory = canonicalDirectory(recoveryInput, "recoveryDirectory");
    if (
      sameDirectory(mapper.root, recoveryDirectory) ||
      sameDirectory(stateDirectory, recoveryDirectory)
    ) {
      throw localError("EINVAL", "recoveryDirectory must not alias root or stateDirectory");
    }
    const identity = { root: mapper.root, stateDirectory, recoveryDirectory };
    const lock = ProcessLock.acquire(rootLockPath(mapper.root), identity);
    let database: NodeSqliteDatabase | undefined;
    let drive: DiskDrive | undefined;
    try {
      bindRecoveryOwner(identity);
      const recovery = new RecoveryCoordinator(mapper, recoveryDirectory, {
        checkpoint: options.recoveryCheckpoint,
      });
      database = new NodeSqliteDatabase(join(stateDirectory, "state.sqlite"), {
        mutationScope: recovery,
        recovery,
        root: mapper.root,
        recoveryDirectory,
      });
      recovery.recover(database.recoveryGeneration());
      const observations = new ObservationClock(database);
      const spillDirectory = canonicalDirectory(join(stateDirectory, "spills"), "spillDirectory");
      drive = new DiskDrive({
        root: mapper.root,
        spillDirectory,
        mutationScope: recovery,
        observations,
        recovery,
      });
      const gitDatabase = new SqliteGitDatabase(database, options);
      const factory = options.git ?? createGit();
      const worktree = drive;
      const git = factory({
        database: gitDatabase,
        worktree,
        exactRootStates: {
          states: (roots) =>
            roots.map((root) => (worktree.stat(root) === null ? "missing" : "present")),
        },
        now: options.now ?? Date.now,
        timezoneOffset: options.timezoneOffset ?? (() => new Date().getTimezoneOffset()),
        defaultIdentity: options.defaultGitIdentity,
        http: options.http,
        promisorAuth: options.promisorAuth,
        promisorHeaders: options.promisorHeaders,
        cliNetwork: options.cliNetwork,
        yieldNow: options.yieldNow,
      });

      this.root = mapper.root;
      this.stateDirectory = stateDirectory;
      this.recoveryDirectory = recoveryDirectory;
      this.database = database;
      this.gitDatabase = gitDatabase;
      this.drive = drive;
      this.git = git;
      this.#lock = lock;
    } catch (error) {
      let databaseClosed = database === undefined;
      try {
        drive?.close();
      } catch {}
      try {
        database?.close();
        databaseClosed = true;
      } catch {}
      if (databaseClosed) lock.close();
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.database.close();
    let failure: unknown;
    try {
      this.drive.close();
    } catch (error) {
      failure = error;
    }
    try {
      this.#lock.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
