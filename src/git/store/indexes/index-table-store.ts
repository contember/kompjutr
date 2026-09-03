import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import type {
  IndexApplyOptions,
  IndexEntry,
  IndexScanOptions,
  IndexSink,
  IndexStore,
  InitialStateResult,
  InitialStateSession,
} from "../core/contracts.js";
import { isThenableResult, requireBooleanProbe } from "../core/json-pages.js";
import { bumpMaintenanceRootEpoch } from "../maintenance/control.js";
import { InitialBlobIdBuffer } from "../objects/blob-ids.js";
import type { SharedRepoStore } from "../repository/shared.js";
import {
  type BufferedIndexMutation,
  DEFAULT_INDEX_FLUSH,
  IndexMutationBuffer,
  type OwnedIndexSource,
  requireScratchIndexEntry,
  requireStoredIndexEntry,
  scanIndexOwned,
  validateInitialIndexEntry,
} from "./index-table-helpers.js";

export class IndexTable implements IndexStore {
  #revoked = false;

  constructor(
    private readonly db: SqlDatabase,
    private readonly source: OwnedIndexSource,
    private readonly requireOwnerActive: () => void,
  ) {}

  revoke(): void {
    this.#revoked = true;
  }

  #requireActive(): void {
    this.requireOwnerActive();
    if (this.#revoked) {
      throw new GitError("EINVAL", "scratch index session is no longer active");
    }
  }

  #checkoutSource(): { kind: "checkout"; repoId: number; checkoutId: number } {
    this.#requireActive();
    if (this.source.kind !== "checkout") {
      throw new CorruptError("scratch index does not own checkout state");
    }
    return this.source;
  }

  #clearRows(): void {
    if (this.source.kind === "checkout") {
      this.db.run("DELETE FROM git_index WHERE checkout_id = ?", this.source.checkoutId);
      return;
    }
    this.db.run(
      "DELETE FROM git_scratch_index_entries WHERE repo_id = ? AND name = ?",
      this.source.repoId,
      this.source.name,
    );
  }

  #applyIndexMutations(pending: readonly BufferedIndexMutation[]): void {
    this.#requireActive();
    const hasRemoves = pending.some((item) => item.kind === "r");
    const hasPuts = pending.some((item) => item.kind === "p");
    const mutations = `[${pending.map((item) => item.json).join(",")}]`;
    if (hasRemoves) {
      if (this.source.kind === "checkout") {
        this.db.run(
          `DELETE FROM git_index
          WHERE checkout_id = ?
            AND path IN (
              SELECT json_extract(value, '$.p') FROM json_each(?)
               WHERE json_extract(value, '$.k') = 'r'
            )`,
          this.source.checkoutId,
          mutations,
        );
      } else {
        this.db.run(
          `DELETE FROM git_scratch_index_entries
          WHERE repo_id = ? AND name = ?
            AND path IN (
              SELECT json_extract(value, '$.p') FROM json_each(?)
               WHERE json_extract(value, '$.k') = 'r'
            )`,
          this.source.repoId,
          this.source.name,
          mutations,
        );
      }
    }
    if (!hasPuts) return;
    const commonSql = `WITH mutation AS (
         SELECT CAST(j.key AS INTEGER) AS q,
                json_extract(j.value, '$.k') AS kind,
                json_extract(j.value, '$.p') AS path,
                json_extract(j.value, '$.g') AS stage,
                json_extract(j.value, '$.m') AS mode,
                json_extract(j.value, '$.o') AS oid,
                json_extract(j.value, '$.s') AS size,
                json_extract(j.value, '$.t') AS mtime,
                json_extract(j.value, '$.i') AS ino,
                json_extract(j.value, '$.r') AS rev
           FROM json_each(?) j
       ), ranked AS (
         SELECT mutation.*,
                max(CASE WHEN kind = 'r' THEN q ELSE -1 END)
                  OVER (PARTITION BY path) AS last_remove,
                max(CASE WHEN kind = 'p' THEN q ELSE -1 END)
                  OVER (PARTITION BY path, stage) AS last_put
           FROM mutation
       )`;
    if (this.source.kind === "checkout") {
      this.db.run(
        `${commonSql}
       INSERT INTO git_index (checkout_id, path, stage, mode, oid, size, mtime, ino, rev)
       SELECT ?, current.path, current.stage, current.mode, current.oid,
              current.size, current.mtime, current.ino, current.rev
         FROM ranked current
        WHERE current.kind = 'p'
          AND current.q = current.last_put
          AND current.q > current.last_remove
        ORDER BY current.q
       ON CONFLICT(checkout_id, path, stage) DO UPDATE SET
         mode = excluded.mode, oid = excluded.oid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino, rev = excluded.rev`,
        mutations,
        this.source.checkoutId,
      );
      return;
    }
    this.db.run(
      `${commonSql}
       INSERT INTO git_scratch_index_entries
         (repo_id, name, path, stage, mode, oid, size, mtime, ino, rev)
       SELECT ?, ?, current.path, current.stage, current.mode, current.oid,
              current.size, current.mtime, current.ino, current.rev
         FROM ranked current
        WHERE current.kind = 'p'
          AND current.q = current.last_put
          AND current.q > current.last_remove
        ORDER BY current.q
       ON CONFLICT(repo_id, name, path, stage) DO UPDATE SET
         mode = excluded.mode, oid = excluded.oid, size = excluded.size,
         mtime = excluded.mtime, ino = excluded.ino, rev = excluded.rev`,
      mutations,
      this.source.repoId,
      this.source.name,
    );
  }

  tryCreateInitialState<T>(body: (session: InitialStateSession) => T): InitialStateResult<T> {
    const source = this.#checkoutSource();
    return this.db.transactionSync(() => {
      const exists = this.db.scalar<number>(
        "SELECT EXISTS(SELECT 1 FROM git_index WHERE checkout_id = ? LIMIT 1)",
        source.checkoutId,
      );
      if (exists !== 0 && exists !== 1) {
        throw new CorruptError("initial index availability probe returned an invalid value");
      }
      if (exists === 1) return { available: false };

      let active = true;
      let failed = false;
      let failure: unknown;
      let previousPath: string | null = null;
      let pending: IndexMutationBuffer | null = null;
      let blobIds: InitialBlobIdBuffer | null = null;
      try {
        pending = new IndexMutationBuffer(DEFAULT_INDEX_FLUSH, (mutations) => {
          this.#applyIndexMutations(mutations);
        });
        blobIds = new InitialBlobIdBuffer(this.db, source.repoId);
        const mutationBuffer = pending;
        const blobBuffer = blobIds;
        const requireActive = (): void => {
          if (!active) throw new Error("initial state session is no longer active");
          if (failed) throw failure;
        };
        const attempt = (operation: () => void): void => {
          requireActive();
          try {
            operation();
          } catch (error) {
            failed = true;
            failure = error;
            throw error;
          }
        };
        const session: InitialStateSession = {
          put: (entry) => {
            attempt(() => {
              validateInitialIndexEntry(entry);
              if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
                throw new CorruptError("initial index entries are not in strict Git path order");
              }
              mutationBuffer.add(entry);
              previousPath = entry.path;
            });
          },
          addBlobId: (mapping) => {
            attempt(() => {
              blobBuffer.validate(mapping);
              if (!blobBuffer.willCache(mapping)) return;
              if (blobBuffer.needsFlush(mapping)) blobBuffer.flush();
              blobBuffer.add(mapping);
            });
          },
        };
        const finish = (): void => {
          attempt(() => mutationBuffer.flush());
          attempt(() => blobBuffer.finish());
        };

        const value = body(session);
        requireActive();
        if (isThenableResult(value)) {
          void Promise.resolve(value).catch(() => {});
          throw new Error("initial state body returned an asynchronous result");
        }
        finish();
        // Blob-id cache writes alone do not change maintenance roots.
        if (previousPath !== null) bumpMaintenanceRootEpoch(this.db, source.repoId);
        return { available: true, value };
      } finally {
        active = false;
        pending?.dispose();
        blobIds?.dispose();
        previousPath = null;
        failure = undefined;
      }
    });
  }

  indexEntries(): IndexEntry[] {
    const source = this.#checkoutSource();
    return this.db
      .all<Record<string, unknown>>(
        "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE checkout_id = ? ORDER BY path, stage",
        source.checkoutId,
      )
      .map(requireStoredIndexEntry);
  }

  indexGet(path: string, stage = 0): IndexEntry | null {
    const source = this.#checkoutSource();
    const row = this.db.one<Record<string, unknown>>(
      "SELECT path, stage, mode, oid, size, mtime, ino, rev FROM git_index WHERE checkout_id = ? AND path = ? AND stage = ?",
      source.checkoutId,
      path,
      stage,
    );
    return row === undefined ? null : requireStoredIndexEntry(row);
  }

  indexPut(entry: IndexEntry): void {
    const source = this.#checkoutSource();
    this.db.transactionSync(() => {
      this.db.run(
        `INSERT INTO git_index (checkout_id, path, stage, mode, oid, size, mtime, ino, rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(checkout_id, path, stage) DO UPDATE SET
           mode = excluded.mode, oid = excluded.oid, size = excluded.size,
           mtime = excluded.mtime, ino = excluded.ino, rev = excluded.rev`,
        source.checkoutId,
        entry.path,
        entry.stage,
        entry.mode,
        entry.oid,
        entry.size,
        entry.mtime,
        entry.ino,
        entry.rev ?? null,
      );
      bumpMaintenanceRootEpoch(this.db, source.repoId);
    });
  }

  /** Remove every stage of `path`. */
  indexRemove(path: string): void {
    const source = this.#checkoutSource();
    this.db.transactionSync(() => {
      this.db.run(
        "DELETE FROM git_index WHERE checkout_id = ? AND path = ?",
        source.checkoutId,
        path,
      );
      bumpMaintenanceRootEpoch(this.db, source.repoId);
    });
  }

  indexClear(): void {
    const source = this.#checkoutSource();
    this.db.transactionSync(() => {
      this.#clearRows();
      bumpMaintenanceRootEpoch(this.db, source.repoId);
    });
  }

  indexReplace(entries: Iterable<IndexEntry>, options: IndexApplyOptions = {}): void {
    this.#requireActive();
    const flushEvery = options.flushEvery ?? DEFAULT_INDEX_FLUSH;
    let first = true;
    const pending = new IndexMutationBuffer(flushEvery, (mutations) => {
      this.db.transactionSync(() => {
        this.#requireActive();
        if (first) this.#clearRows();
        this.#applyIndexMutations(mutations);
        if (this.source.kind === "checkout") {
          bumpMaintenanceRootEpoch(this.db, this.source.repoId);
        }
      });
      first = false;
    });
    for (const entry of entries) {
      pending.add(this.source.kind === "scratch" ? requireScratchIndexEntry(entry) : entry);
    }
    pending.flush();
    if (first) {
      if (this.source.kind === "checkout") this.indexClear();
      else this.#clearRows();
    }
  }

  *indexScan(options: IndexScanOptions = {}): Generator<IndexEntry> {
    yield* scanIndexOwned(this.db, this.source, () => this.#requireActive(), options);
  }

  indexApply<T>(body: (sink: IndexSink) => T, options: IndexApplyOptions = {}): T {
    this.#requireActive();
    const flushEvery = options.flushEvery ?? DEFAULT_INDEX_FLUSH;
    const pending = new IndexMutationBuffer(flushEvery, (mutations) => {
      this.db.transactionSync(() => {
        this.#applyIndexMutations(mutations);
        if (this.source.kind === "checkout") {
          bumpMaintenanceRootEpoch(this.db, this.source.repoId);
        }
      });
    });
    if (this.source.kind === "checkout") {
      const sink: IndexSink = {
        put: (entry) => pending.add(entry),
        remove: (path) => pending.add(path),
        flush: () => pending.flush(),
      };
      const result = body(sink);
      pending.flush();
      return result;
    }
    let sinkActive = true;
    const requireSinkActive = (): void => {
      this.#requireActive();
      if (!sinkActive) throw new GitError("EINVAL", "index mutation sink is no longer active");
    };
    const sink: IndexSink = {
      put: (entry) => {
        requireSinkActive();
        pending.add(requireScratchIndexEntry(entry));
      },
      remove: (path) => {
        requireSinkActive();
        pending.add(path);
      },
      flush: () => {
        requireSinkActive();
        pending.flush();
      },
    };
    try {
      const result = body(sink);
      if (isThenableResult(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new GitError("EINVAL", "index mutation callback must be synchronous");
      }
      pending.flush();
      return result;
    } finally {
      sinkActive = false;
      pending.dispose();
    }
  }

  hasConflicts(): boolean {
    this.#requireActive();
    if (this.source.kind === "checkout") {
      return (
        (this.db.scalar<number>(
          "SELECT COUNT(*) FROM (SELECT 1 FROM git_index WHERE checkout_id = ? AND stage > 0 LIMIT 1)",
          this.source.checkoutId,
        ) ?? 0) > 0
      );
    }
    return requireBooleanProbe(
      this.db.scalar<unknown>(
        `SELECT EXISTS(
           SELECT 1 FROM git_scratch_index_entries
            WHERE repo_id = ? AND name = ? AND stage > 0 LIMIT 1
         )`,
        this.source.repoId,
        this.source.name,
      ),
      "scratch index conflict probe",
    );
  }

  hasCheckoutBlockingIndexEntries(): boolean {
    const source = this.#checkoutSource();
    return (
      (this.db.scalar<number>(
        `SELECT COUNT(*) FROM (
           SELECT 1 FROM git_index
            WHERE checkout_id = ? AND (stage > 0 OR (stage = 0 AND mode = 57344)) LIMIT 1
         )`,
        source.checkoutId,
      ) ?? 0) > 0
    );
  }
}

/** Repository-scoped index rows whose lifetime is one synchronous callback. */
export class ScratchIndexStore extends IndexTable {
  constructor(shared: SharedRepoStore, name: string) {
    super(shared.db, { kind: "scratch", repoId: shared.repoId, name }, () => {});
  }
}
