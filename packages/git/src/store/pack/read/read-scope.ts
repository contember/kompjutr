import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../../common/errors.js";
import { readRepositorySourceGeneration } from "../../core/source-generation.js";
import { scratchTransactionsFor } from "../../repository/shared-support.js";

/**
 * A paged packed read writes owner-scoped scratch rows, so it needs an identity
 * for the source set it discovered against. Drift inside one synchronous scope
 * is a reentrancy bug in a store seam, not a race with another writer, so the
 * verdict is `ECORRUPT` rather than `ESTALE`: no durable ownership was taken.
 */
const SOURCE_CHANGED = "packed read observed a source change";

interface PackReadSourceSnapshot {
  readonly sourceGeneration: number;
  readonly pendingPackId: number | null;
  readonly pendingState: string | null;
}

export class PackReadScope {
  #active = true;
  readonly #cursors = new Set<Iterator<unknown>>();

  constructor(readonly readId: string) {}

  requireActive(): void {
    if (!this.#active) throw new GitError("ESTALE", "packed read scope is no longer active");
  }

  revoke(): void {
    this.#active = false;
    this.closeCursors();
  }

  closeCursors(): void {
    for (const cursor of this.#cursors) cursor.return?.();
    this.#cursors.clear();
  }

  /** Every scratch cursor the scope opens, drained before the transaction boundary. */
  *scoped<T>(entries: Iterable<T>): Generator<T> {
    this.requireActive();
    const cursor = entries[Symbol.iterator]();
    this.#cursors.add(cursor);
    try {
      while (true) {
        this.requireActive();
        const item = cursor.next();
        if (item.done === true) return;
        yield item.value;
      }
    } finally {
      this.#cursors.delete(cursor);
      cursor.return?.();
    }
  }
}

class PackReadScopeCoordinator {
  #depth = 0;
  #snapshot: PackReadSourceSnapshot | null = null;

  enter(): boolean {
    this.#depth++;
    return this.#depth === 1;
  }

  leave(): void {
    this.#depth--;
    if (this.#depth < 0) throw new CorruptError("packed read scope depth did not close");
    if (this.#depth === 0) this.#snapshot = null;
  }

  adopt(snapshot: PackReadSourceSnapshot): PackReadSourceSnapshot {
    this.#snapshot = snapshot;
    return snapshot;
  }

  /** Nested scopes inherit the outermost snapshot; nothing can change inside it. */
  inherited(): PackReadSourceSnapshot {
    if (this.#snapshot === null) {
      throw new CorruptError("nested packed read scope lost its source snapshot");
    }
    return this.#snapshot;
  }
}

const coordinatorsByDatabase = new WeakMap<SqlDatabase, PackReadScopeCoordinator>();

function coordinatorFor(db: SqlDatabase): PackReadScopeCoordinator {
  const existing = coordinatorsByDatabase.get(db);
  if (existing !== undefined) return existing;
  const created = new PackReadScopeCoordinator();
  coordinatorsByDatabase.set(db, created);
  return created;
}

function readPendingState(db: SqlDatabase, repoId: number, packId: number): string | null {
  const state = db.scalar<unknown>(
    "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
    repoId,
    packId,
  );
  if (state === undefined) return null;
  if (typeof state !== "string") throw new CorruptError("pending pack state is invalid");
  return state;
}

function readSourceSnapshot(
  db: SqlDatabase,
  repoId: number,
  pendingPackId: number | null,
): PackReadSourceSnapshot {
  const sourceGeneration = readRepositorySourceGeneration(db, repoId);
  if (pendingPackId === null) {
    return { sourceGeneration, pendingPackId: null, pendingState: null };
  }
  return {
    sourceGeneration,
    pendingPackId,
    pendingState: readPendingState(db, repoId, pendingPackId),
  };
}

function requireUnchangedSources(
  db: SqlDatabase,
  repoId: number,
  snapshot: PackReadSourceSnapshot,
): void {
  if (readRepositorySourceGeneration(db, repoId) !== snapshot.sourceGeneration) {
    throw new CorruptError(SOURCE_CHANGED);
  }
  const pendingPackId = snapshot.pendingPackId;
  if (pendingPackId === null) return;
  if (readPendingState(db, repoId, pendingPackId) !== snapshot.pendingState) {
    throw new CorruptError(SOURCE_CHANGED);
  }
}

/**
 * Own one paged packed read: snapshot the sources, write scratch under a unique
 * owner, re-assert the snapshot, and release. The scope refuses to open inside a
 * poisoned scratch transaction but never poisons one itself — its rows cascade
 * and roll back alone, and an `E2BIG` from a caller mistake must not make an
 * enclosing integration operation uncommittable.
 */
export function withPackReadScope<T>(
  db: SqlDatabase,
  repoId: number,
  pendingPackId: number | null,
  body: (scope: PackReadScope) => T,
): T {
  scratchTransactionsFor(db).requireHealthy();
  const coordinator = coordinatorFor(db);
  const scope = new PackReadScope(crypto.randomUUID());
  const outermost = coordinator.enter();
  try {
    return db.transactionSync(() => {
      const snapshot = outermost
        ? coordinator.adopt(readSourceSnapshot(db, repoId, pendingPackId))
        : coordinator.inherited();
      db.run(
        "INSERT INTO git_pack_read_scopes (repo_id, read_id) VALUES (?, ?)",
        repoId,
        scope.readId,
      );
      try {
        const result = body(scope);
        if (outermost) requireUnchangedSources(db, repoId, snapshot);
        scope.closeCursors();
        const released = db.one<{ read_id: unknown }>(
          "DELETE FROM git_pack_read_scopes WHERE repo_id = ? AND read_id = ? RETURNING read_id",
          repoId,
          scope.readId,
        );
        if (released?.read_id !== scope.readId) {
          throw new CorruptError("packed read scope ownership changed");
        }
        return result;
      } finally {
        scope.revoke();
      }
    });
  } finally {
    coordinator.leave();
  }
}
