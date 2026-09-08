import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { localError, normalizeHostError } from "../errors.js";
import {
  comparePaths,
  type PathMapper,
  requireCanonicalAbsolutePath,
  virtualParent,
} from "../paths.js";
import type {
  RecoveryCheckpoint,
  RecoveryCheckpointHandler,
  RecoveryTransactionOwner,
} from "./contracts.js";
import { pathExists, syncDirectory } from "./fs.js";
import {
  type InitialRecord,
  JournalWriter,
  MAX_JOURNAL_RECORDS,
  MAX_RECOVERY_ACTIONS,
  type ProbeRecord,
  type RecoveryManifest,
  readJournal,
  type TemporaryRecord,
  type TouchRecord,
  validateRecoveryManifest,
} from "./journal.js";
import { type PreparedPath, planRecoveryPreparation, preparedPaths } from "./preparation.js";
import { settleRecovery } from "./settlement.js";

export type { PreparedPath } from "./preparation.js";

interface ActiveRecovery {
  readonly id: string;
  readonly directory: string;
  readonly journalPath: string;
  readonly baseGeneration: number;
  readonly targetGeneration: number;
  writer: JournalWriter | null;
  readonly probes: ProbeRecord[];
  readonly probeParents: Set<string>;
  readonly touches: TouchRecord[];
  readonly touchPaths: Set<string>;
  readonly temporaries: TemporaryRecord[];
  effects: number;
  backupSequence: number;
  temporarySequence: number;
}

export interface RecoveryCoordinatorOptions {
  readonly checkpoint?: RecoveryCheckpointHandler;
  readonly probeRename?: (source: string, destination: string) => void;
  readonly journalActionLimit?: number;
  readonly journalFrameBytes?: number;
}

function requireSafeRecoveryEntry(name: string): void {
  if (!/^tx-[a-f0-9-]{16,64}$/.test(name)) {
    throw localError("ECORRUPT", `unexpected recovery entry: ${name}`);
  }
}

export class RecoveryCoordinator implements RecoveryTransactionOwner {
  readonly #mapper: PathMapper;
  readonly #root: string;
  readonly #checkpointHandler: RecoveryCheckpointHandler | undefined;
  readonly #probeRename: (source: string, destination: string) => void;
  readonly #journalActionLimit: number;
  readonly #journalFrameBytes: number | undefined;
  #active: ActiveRecovery | null = null;
  #abortOnly = false;
  #poisoned = false;

  constructor(mapper: PathMapper, recoveryRoot: string, options: RecoveryCoordinatorOptions = {}) {
    requireCanonicalAbsolutePath(recoveryRoot, "recoveryRoot");
    this.#mapper = mapper;
    this.#root = recoveryRoot;
    this.#checkpointHandler = options.checkpoint;
    this.#probeRename = options.probeRename ?? renameSync;
    this.#journalActionLimit = options.journalActionLimit ?? MAX_RECOVERY_ACTIONS;
    this.#journalFrameBytes = options.journalFrameBytes;
  }

  checkpoint(checkpoint: RecoveryCheckpoint): void {
    this.#checkpointHandler?.(checkpoint);
  }

  begin(baseGeneration: number): void {
    if (this.#poisoned) {
      throw localError("ERECOVERY", "reopen the workspace before another disk mutation");
    }
    if (this.#active !== null) throw localError("EREENTRANT", "disk recovery transaction reentry");
    if (
      !Number.isSafeInteger(baseGeneration) ||
      baseGeneration < 0 ||
      baseGeneration === Number.MAX_SAFE_INTEGER
    ) {
      throw localError("E2BIG", "recovery generation is exhausted");
    }
    const id = randomUUID();
    const directory = join(this.#root, `tx-${id}`);
    this.#abortOnly = false;
    this.#active = {
      id,
      directory,
      journalPath: join(directory, "journal"),
      baseGeneration,
      targetGeneration: baseGeneration + 1,
      writer: null,
      probes: [],
      probeParents: new Set(),
      touches: [],
      touchPaths: new Set(),
      temporaries: [],
      effects: 0,
      backupSequence: 0,
      temporarySequence: 0,
    };
  }

  get diskChanged(): boolean {
    return this.diskEffects > 0;
  }

  get diskEffects(): number {
    return this.#active?.effects ?? 0;
  }

  get abortOnly(): boolean {
    return this.#abortOnly;
  }

  operationFailed(): void {
    if (this.#active !== null) this.#abortOnly = true;
  }

  #requireActive(): ActiveRecovery {
    if (this.#poisoned) {
      throw localError("ERECOVERY", "reopen the workspace before another disk mutation");
    }
    if (this.#abortOnly) {
      throw localError("ERECOVERY", "a failed disk operation made the transaction abort-only");
    }
    if (this.#active === null) {
      throw localError("EUNSUPPORTED", "disk mutation requires an active SQLite transaction");
    }
    return this.#active;
  }

  #ensureJournal(active: ActiveRecovery): JournalWriter {
    if (active.writer !== null) return active.writer;
    try {
      mkdirSync(active.directory, 0o700);
      syncDirectory(this.#root);
    } catch (error) {
      try {
        rmSync(active.directory, { force: true, recursive: true });
        syncDirectory(this.#root);
      } catch {}
      normalizeHostError(error, "create recovery transaction", active.directory);
    }
    let writer: JournalWriter;
    try {
      writer = new JournalWriter(
        active.journalPath,
        MAX_JOURNAL_RECORDS,
        this.#journalActionLimit,
        this.#journalFrameBytes,
      );
    } catch (error) {
      try {
        rmSync(active.directory, { force: true, recursive: true });
        syncDirectory(this.#root);
      } catch {}
      throw error;
    }
    active.writer = writer;
    const initial: InitialRecord = {
      kind: "initial",
      sequence: 0,
      version: 1,
      transaction: active.id,
      baseGeneration: active.baseGeneration,
      targetGeneration: active.targetGeneration,
    };
    writer.append(initial);
    syncDirectory(active.directory);
    this.checkpoint("journal-created");
    return writer;
  }

  #nearestExistingParent(path: string): string {
    let current = virtualParent(path);
    for (;;) {
      if (pathExists(this.#mapper.lexicalHost(current))) return current;
      if (current === "/") throw localError("ENOENT", "workspace root disappeared during mutation");
      current = virtualParent(current);
    }
  }

  #probe(parent: string, active: ActiveRecovery, writer: JournalWriter): void {
    if (active.probeParents.has(parent)) return;
    const token = randomUUID();
    const origin = `probe-${token}`;
    const destination = `.kompjutr-probe-${token}`;
    const record: ProbeRecord = {
      kind: "probe",
      sequence: active.probes.length + active.touches.length + active.temporaries.length + 1,
      parent,
      origin,
      destination,
    };
    writer.append({ kind: "probe", parent, origin, destination });
    active.probes.push(record);
    active.probeParents.add(parent);
    this.checkpoint("probe-intent");

    const source = join(active.directory, origin);
    const targetParent = this.#mapper.lexicalHost(parent);
    const target = join(targetParent, destination);
    let fd: number | undefined;
    try {
      fd = openSync(source, "wx", 0o600);
      writeFileSync(fd, active.id);
      fsyncSync(fd);
    } catch (error) {
      throw localError(
        "EXDEV",
        `rename probe could not be created: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    syncDirectory(active.directory);
    try {
      this.#probeRename(source, target);
      syncDirectory(active.directory);
      syncDirectory(targetParent);
    } catch (error) {
      throw localError(
        "EXDEV",
        `recovery rename probe failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    this.checkpoint("probe-placed");
    try {
      this.#probeRename(target, source);
      syncDirectory(targetParent);
      syncDirectory(active.directory);
    } catch (error) {
      throw localError(
        "EXDEV",
        `recovery rename probe could not return: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    this.checkpoint("probe-returned");
    unlinkSync(source);
    syncDirectory(active.directory);
    this.checkpoint("probe-cleaned");
  }

  prepare(paths: readonly string[]): readonly PreparedPath[] {
    const active = this.#requireActive();
    if (paths.length === 0) return [];
    const plan = planRecoveryPreparation(
      this.#mapper,
      paths,
      active.touchPaths,
      active.backupSequence,
    );
    const { requested, touches } = plan;
    active.backupSequence = plan.nextBackupSequence;

    if (touches.length > 0) {
      const writer = this.#ensureJournal(active);
      const recoveryDevice = lstatSync(active.directory).dev;
      const parents = new Set<string>();
      for (const touch of touches) {
        const host = this.#mapper.lexicalHost(touch.path);
        const parent = this.#nearestExistingParent(touch.path);
        const parentHost = this.#mapper.lexicalHost(parent);
        if (lstatSync(parentHost).dev !== recoveryDevice) {
          throw localError(
            "EXDEV",
            "mutation parent and recovery directory are on different devices",
            touch.path,
          );
        }
        if (pathExists(host) && lstatSync(host).dev !== recoveryDevice) {
          throw localError(
            "EXDEV",
            "mutation target and recovery directory are on different devices",
            touch.path,
          );
        }
        parents.add(parent);
      }
      for (const parent of parents) this.#probe(parent, active, writer);
      writer.appendApplication(touches, () => this.checkpoint("application-frame-synced"));
      active.touches.push(...touches);
      for (const touch of touches) active.touchPaths.add(touch.path);
      this.checkpoint("application-intent");

      for (const touch of touches) {
        if (touch.backup === null) continue;
        const source = this.#mapper.lexicalHost(touch.path);
        const destination = join(active.directory, touch.backup);
        try {
          renameSync(source, destination);
          syncDirectory(active.directory);
          this.checkpoint("backup-destination-synced");
          syncDirectory(dirname(source));
        } catch (error) {
          normalizeHostError(error, "move recovery backup", touch.path);
        }
        active.effects++;
        this.checkpoint("backup-moved");
      }
    }

    return preparedPaths(requested, touches, active.directory);
  }

  markChanged(): void {
    this.#requireActive().effects++;
  }

  temporary(parent: string): string {
    const active = this.#requireActive();
    const writer = this.#ensureJournal(active);
    const canonicalParent = this.#mapper.resolve(parent, true);
    const name = `.kompjutr-tmp-${active.id}-${active.temporarySequence++}`;
    writer.append({ kind: "temporary", parent: canonicalParent, name });
    active.temporaries.push({
      kind: "temporary",
      sequence: active.probes.length + active.touches.length + active.temporaries.length + 1,
      parent: canonicalParent,
      name,
    });
    this.checkpoint("temporary-intent");
    return join(this.#mapper.lexicalHost(canonicalParent), name);
  }

  parentCreated(): void {
    this.markChanged();
    this.checkpoint("parent-created");
  }

  commitSucceeded(): void {
    this.#finish(true);
  }

  rollback(): void {
    this.#finish(false);
  }

  settleUncertain(committedGeneration: number): void {
    const active = this.#active;
    if (active === null) return;
    this.#finish(committedGeneration >= active.targetGeneration);
  }

  abandon(): void {
    this.#poisoned = true;
    try {
      this.#active?.writer?.close();
    } catch {}
    this.#active = null;
    this.#abortOnly = false;
  }

  #finish(committed: boolean): void {
    const active = this.#active;
    if (active === null) return;
    let finished = false;
    try {
      active.writer?.close();
      if (active.writer === null) {
        finished = true;
        return;
      }
      const manifest: RecoveryManifest = {
        initial: {
          kind: "initial",
          sequence: 0,
          version: 1,
          transaction: active.id,
          baseGeneration: active.baseGeneration,
          targetGeneration: active.targetGeneration,
        },
        probes: active.probes,
        touches: active.touches,
        temporaries: active.temporaries,
      };
      validateRecoveryManifest(manifest);
      this.#settle(active.directory, manifest, committed);
      finished = true;
    } catch (error) {
      this.#poisoned = true;
      throw error;
    } finally {
      if (finished) {
        this.#active = null;
        this.#abortOnly = false;
      }
    }
  }

  recover(committedGeneration: number): void {
    if (this.#poisoned) {
      throw localError("ERECOVERY", "reopen the workspace before recovery is retried");
    }
    try {
      this.#recover(committedGeneration);
    } catch (error) {
      this.#poisoned = true;
      throw error;
    }
  }

  #recover(committedGeneration: number): void {
    const entries = readdirSync(this.#root, { withFileTypes: true });
    const pending: Array<{ directory: string; manifest: RecoveryManifest | null }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory())
        throw localError("ECORRUPT", `unexpected recovery file: ${entry.name}`);
      requireSafeRecoveryEntry(entry.name);
      const directory = join(this.#root, entry.name);
      const journal = join(directory, "journal");
      if (!pathExists(journal)) {
        if (readdirSync(directory).length !== 0) {
          throw localError("ECORRUPT", `recovery transaction has no journal: ${entry.name}`);
        }
        pending.push({ directory, manifest: null });
        continue;
      }
      const manifest = readJournal(journal);
      if (manifest === null) {
        if (readdirSync(directory).some((name) => name !== "journal")) {
          throw localError("ECORRUPT", `empty recovery journal has extra entries: ${entry.name}`);
        }
        pending.push({ directory, manifest: null });
        continue;
      }
      if (`tx-${manifest.initial.transaction}` !== entry.name) {
        throw localError("ECORRUPT", "recovery transaction identity does not match its directory");
      }
      pending.push({ directory, manifest });
    }
    pending.sort((left, right) => comparePaths(left.directory, right.directory));
    for (const item of pending) {
      if (item.manifest === null) {
        rmSync(item.directory, { recursive: true });
        syncDirectory(this.#root);
        continue;
      }
      this.#settle(
        item.directory,
        item.manifest,
        committedGeneration >= item.manifest.initial.targetGeneration,
      );
    }
  }

  #settle(directory: string, manifest: RecoveryManifest, committed: boolean): void {
    settleRecovery(this.#mapper, this.#root, directory, manifest, committed, (checkpoint) =>
      this.checkpoint(checkpoint),
    );
  }
}
