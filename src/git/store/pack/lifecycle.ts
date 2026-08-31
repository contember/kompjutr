// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "../../../db/db.js";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import {
  type CompletePackedEntry,
  type CompletePackObject,
  type ExpectedPackMembership,
  isObjectType,
  MAX_PACK_DELETE_BATCH,
  MAX_PACK_DELTA_WORKING_BYTES,
  MAX_PACK_MEMBERSHIP_OBJECTS,
  PACK_INGEST_LEASE_MS,
  type PackIngestControl,
  type PackIngestLease,
  type PackIngestLifecycle,
  type PackSharedState,
  requireIngestControl,
  requireIngestTime,
  requireLifecycleResult,
  requirePackId,
  uniquePackIds,
} from "./shared.js";

export class PackLifecycle {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #sharedState: PackSharedState;
  readonly #now: () => number;

  constructor(db: SqlDatabase, repoId: number, sharedState: PackSharedState, now: () => number) {
    this.#db = db;
    this.#repoId = repoId;
    this.#sharedState = sharedState;
    this.#now = now;
  }

  #clearCaches(): void {
    this.#sharedState.cacheGeneration++;
  }

  #ensureIngestControl(): PackIngestControl {
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms
         FROM git_pack_ingest_control WHERE repo_id = ?`,
      this.#repoId,
    );
    if (row === undefined) throw new CorruptError("pack ingest control is missing");
    return requireIngestControl(row, this.#repoId);
  }

  #nextPackId(control: PackIngestControl): number {
    const latest = this.#db.scalar<number | null>(
      "SELECT MAX(pack_id) FROM git_pack_meta WHERE repo_id = ?",
      this.#repoId,
    );
    if (latest !== undefined && latest !== null && (!Number.isSafeInteger(latest) || latest < 0)) {
      throw new CorruptError("pack id allocation state is invalid");
    }
    const last = Math.max(control.lastPackId, latest ?? 0);
    if (last === Number.MAX_SAFE_INTEGER) {
      throw new GitError("E2BIG", "pack id allocation is exhausted");
    }
    return last + 1;
  }

  #reclaimPendingRows(
    control: PackIngestControl,
    nowMs: number,
  ): {
    control: PackIngestControl;
    removed: number;
  } {
    const ids = new Set<number>();
    let current = control;
    let livePackId: number | null = null;
    if (control.activePackId !== null) {
      if (control.expiresMs === null) throw new CorruptError("pack ingest lease expiry is missing");
      const owner = this.#db.one<Record<string, unknown>>(
        `SELECT pack.state AS state,
                EXISTS(
                  SELECT 1 FROM git_maintenance_repack_batches batch
                   WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id
                ) AS maintenance_owned
           FROM git_pack_meta pack
          WHERE pack.repo_id = ? AND pack.pack_id = ?`,
        this.#repoId,
        control.activePackId,
      );
      if (owner === undefined) throw new CorruptError("active pack ingest identity is missing");
      if (owner.state !== "pending" || owner.maintenance_owned !== 0) {
        throw new CorruptError("active ordinary pack ingest ownership is invalid");
      }
      if (nowMs < control.expiresMs) {
        livePackId = control.activePackId;
      } else {
        const cleared = this.#db.one<Record<string, unknown>>(
          `UPDATE git_pack_ingest_control
              SET active_pack_id = NULL, expires_ms = NULL
            WHERE repo_id = ? AND owner_generation = ? AND active_pack_id = ?
          RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
          this.#repoId,
          control.ownerGeneration,
          control.activePackId,
        );
        if (cleared === undefined) throw new CorruptError("expired pack ingest lease changed");
        current = requireIngestControl(cleared, this.#repoId);
        ids.add(control.activePackId);
      }
    }
    const collect = (rows: Iterable<Record<string, unknown>>, requirePending: boolean): void => {
      for (const row of rows) {
        const packId = row.pack_id;
        if (typeof packId !== "number" || !Number.isSafeInteger(packId) || packId < 0) {
          throw new CorruptError("pending pack query returned an invalid pack id");
        }
        if (requirePending && row.state !== "pending") {
          throw new CorruptError(`pack ${packId}: invalid pending cleanup state`);
        }
        ids.add(packId);
      }
    };
    collect(
      this.#db.iterate(
        `SELECT pack.pack_id AS pack_id, pack.state AS state
           FROM git_pack_meta pack
          WHERE pack.repo_id = ? AND pack.state IS NOT 'complete'
            AND (? IS NULL OR pack.pack_id != ?)
            AND pack.pack_id NOT IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (
              SELECT 1 FROM git_maintenance_repack_batches batch
               WHERE batch.repo_id = pack.repo_id AND batch.pack_id = pack.pack_id
            )
          ORDER BY pack.pack_id LIMIT ?`,
        this.#repoId,
        livePackId,
        livePackId,
        JSON.stringify([...this.#sharedState.activePending]),
        MAX_PACK_DELETE_BATCH + 1,
      ),
      true,
    );
    collect(
      this.#db.iterate(
        `SELECT DISTINCT data.pack_id AS pack_id
           FROM git_pack_data data
           LEFT JOIN git_pack_meta pack
             ON pack.repo_id = data.repo_id AND pack.pack_id = data.pack_id
          WHERE data.repo_id = ? AND pack.pack_id IS NULL
          ORDER BY data.pack_id LIMIT ?`,
        this.#repoId,
        MAX_PACK_DELETE_BATCH + 1,
      ),
      false,
    );
    if (ids.size > MAX_PACK_DELETE_BATCH) {
      throw new GitError("E2BIG", `pending pack cleanup exceeds ${MAX_PACK_DELETE_BATCH} packs`);
    }
    for (const packId of ids) this.#deletePack(packId, [packId]);
    return { control: current, removed: ids.size };
  }

  /** Drop only unowned or expired ordinary packs. */
  reclaimPending(now: () => number = this.#now): number {
    const nowMs = requireIngestTime(now);
    const removed = this.#db.transactionSync(() => {
      const control = this.#ensureIngestControl();
      return this.#reclaimPendingRows(control, nowMs).removed;
    });
    if (removed > 0) this.#clearCaches();
    return removed;
  }

  #assertNotDurablyActive(packId: number): void {
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms
         FROM git_pack_ingest_control WHERE repo_id = ?`,
      this.#repoId,
    );
    if (row === undefined) throw new CorruptError("pack ingest control is missing");
    if (requireIngestControl(row, this.#repoId).activePackId === packId) {
      throw new GitError("EBUSY", `pack ${packId} is active`);
    }
  }

  /** Delete exactly one pending pack after its owner releases the durable reference. */
  discardPending(packId: number, releaseOwnership?: (packId: number) => unknown): boolean {
    requirePackId(packId);
    const removed = this.#db.transactionSync(() => {
      if (this.#sharedState.activePending.has(packId)) {
        throw new GitError("EBUSY", `pack ${packId} is active`);
      }
      this.#assertNotDurablyActive(packId);
      const row = this.#db.one<{ state: unknown }>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        this.#repoId,
        packId,
      );
      if (row === undefined) return false;
      if (row.state !== "pending" && row.state !== "complete") {
        throw new CorruptError(`pack ${packId}: invalid state`);
      }
      if (row.state !== "pending") {
        throw new GitError("EBUSY", `pack ${packId} is already complete`);
      }
      if (releaseOwnership !== undefined) {
        requireLifecycleResult(releaseOwnership(packId), "ownership release");
      }
      const current = this.#db.one<{ state: unknown }>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        this.#repoId,
        packId,
      );
      if (current?.state !== "pending") {
        throw new CorruptError(`pack ${packId}: ownership release changed pending pack state`);
      }
      this.#deletePack(packId, [packId]);
      return true;
    });
    if (removed) this.#clearCaches();
    return removed;
  }

  /** Release and delete exactly one complete pack owned by a durable maintenance batch. */
  discardOwnedComplete(packId: number, releaseOwnership: (packId: number) => unknown): boolean {
    requirePackId(packId);
    if (typeof releaseOwnership !== "function") {
      throw new RangeError("complete pack ownership release must be a function");
    }
    const removed = this.#db.transactionSync(() => {
      if (this.#sharedState.activePending.has(packId)) {
        throw new GitError("EBUSY", `pack ${packId} is active`);
      }
      this.#assertNotDurablyActive(packId);
      const row = this.#db.one<{ state: unknown }>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        this.#repoId,
        packId,
      );
      if (row === undefined) return false;
      if (row.state !== "pending" && row.state !== "complete") {
        throw new CorruptError(`pack ${packId}: invalid state`);
      }
      if (row.state !== "complete") {
        throw new GitError("EBUSY", `pack ${packId} is still pending`);
      }
      requireLifecycleResult(releaseOwnership(packId), "ownership release");
      const current = this.#db.one<{ state: unknown }>(
        "SELECT state FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
        this.#repoId,
        packId,
      );
      if (current?.state !== "complete") {
        throw new CorruptError(`pack ${packId}: ownership release changed complete pack state`);
      }
      this.#deletePack(packId, [packId]);
      let rows = 0;
      for (const validation of this.#db.iterate(
        `SELECT /* owned-complete-discard-validation */ EXISTS(
           SELECT 1 FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_data WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_entries WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_objects WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_pack_pending WHERE repo_id = ? AND pack_id = ?
           UNION ALL SELECT 1 FROM git_tree_sources
             WHERE repo_id = ? AND storage = 'pack' AND source_id = ?
         ) AS remains`,
        this.#repoId,
        packId,
        this.#repoId,
        packId,
        this.#repoId,
        packId,
        this.#repoId,
        packId,
        this.#repoId,
        packId,
        this.#repoId,
        packId,
      )) {
        if (validation.remains !== 0 || rows !== 0) {
          throw new CorruptError(
            `pack ${packId}: complete discard did not remove exactly one pack`,
          );
        }
        rows++;
      }
      if (rows !== 1) {
        throw new CorruptError(`pack ${packId}: complete discard validation returned no row`);
      }
      return true;
    });
    if (removed) this.#clearCaches();
    return removed;
  }

  /** Verify that one complete pack contains exactly the requested object metadata. */
  completePackMatches(packId: number, objects: readonly CompletePackObject[]): boolean {
    requirePackId(packId);
    if (objects.length > MAX_PACK_MEMBERSHIP_OBJECTS) {
      throw new GitError("E2BIG", `pack membership exceeds ${MAX_PACK_MEMBERSHIP_OBJECTS} objects`);
    }
    const expected = new Map<string, { type: ObjectType; size: number }>();
    for (const object of objects) {
      if (
        !isOid(object.oid) ||
        !isObjectType(object.type) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0
      ) {
        throw new RangeError("pack membership contains invalid object metadata");
      }
      if (expected.has(object.oid)) throw new RangeError(`duplicate pack object ${object.oid}`);
      expected.set(object.oid, { type: object.type, size: object.size });
    }
    const meta = this.#db.one<{ state: unknown; count: unknown; size: unknown }>(
      "SELECT state, count, size FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
      this.#repoId,
      packId,
    );
    if (meta === undefined) return false;
    if (
      (meta.state !== "pending" && meta.state !== "complete") ||
      typeof meta.count !== "number" ||
      !Number.isSafeInteger(meta.count) ||
      meta.count < 0 ||
      typeof meta.size !== "number" ||
      !Number.isSafeInteger(meta.size) ||
      meta.size < 0
    ) {
      throw new CorruptError(`pack ${packId}: invalid metadata`);
    }
    if (meta.state !== "complete" || meta.count !== expected.size) return false;

    let found = 0;
    let previousOid: string | null = null;
    for (const row of this.#db.iterate(
      `SELECT /* complete-pack-membership */ entry.oid, entry.pack_id, entry.offset,
              entry.data_off, entry.data_len, entry.type, entry.size, entry.entry_size,
              entry.base_oid, object.pack_id AS owner_pack_id, owner.state AS owner_state,
              object.offset AS owner_offset, object.data_off AS owner_data_off,
              object.data_len AS owner_data_len, object.type AS owner_type,
              object.size AS owner_size, object.entry_size AS owner_entry_size,
              object.base_oid AS owner_base_oid
         FROM git_pack_entries entry
         LEFT JOIN git_pack_objects object
           ON object.repo_id = entry.repo_id AND object.oid = entry.oid
         LEFT JOIN git_pack_meta owner
           ON owner.repo_id = object.repo_id AND owner.pack_id = object.pack_id
        WHERE entry.repo_id = ? AND entry.pack_id = ?
        ORDER BY entry.oid COLLATE BINARY LIMIT ?`,
      this.#repoId,
      packId,
      expected.size + 1,
    )) {
      const oid = row.oid;
      const rowPackId = row.pack_id;
      const offset = row.offset;
      const dataOff = row.data_off;
      const dataLen = row.data_len;
      const type = row.type;
      const size = row.size;
      const entrySize = row.entry_size;
      const baseOid = row.base_oid;
      if (
        typeof oid !== "string" ||
        !isOid(oid) ||
        typeof rowPackId !== "number" ||
        !Number.isSafeInteger(rowPackId) ||
        rowPackId !== packId ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        typeof dataOff !== "number" ||
        !Number.isSafeInteger(dataOff) ||
        dataOff < offset ||
        typeof dataLen !== "number" ||
        !Number.isSafeInteger(dataLen) ||
        dataLen < 0 ||
        !Number.isSafeInteger(dataOff + dataLen) ||
        dataOff + dataLen > meta.size ||
        typeof type !== "string" ||
        !isObjectType(type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        typeof entrySize !== "number" ||
        !Number.isSafeInteger(entrySize) ||
        entrySize < 0 ||
        (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid))) ||
        typeof row.owner_pack_id !== "number" ||
        !Number.isSafeInteger(row.owner_pack_id) ||
        row.owner_pack_id < 0 ||
        row.owner_state !== "complete" ||
        row.owner_type !== type ||
        row.owner_size !== size ||
        (row.owner_pack_id === packId &&
          (row.owner_offset !== offset ||
            row.owner_data_off !== dataOff ||
            row.owner_data_len !== dataLen ||
            row.owner_entry_size !== entrySize ||
            row.owner_base_oid !== baseOid)) ||
        (previousOid !== null && oid <= previousOid)
      ) {
        throw new CorruptError(`pack ${packId}: invalid object membership`);
      }
      const wanted = expected.get(oid);
      if (wanted === undefined || wanted.type !== type || wanted.size !== size) return false;
      expected.delete(oid);
      previousOid = oid;
      found++;
    }
    return found === objects.length && expected.size === 0;
  }

  /** Read packed metadata directly, ignoring any loose object that shadows it. */
  completePackedEntry(oid: string): CompletePackedEntry | null {
    if (!isOid(oid)) throw new RangeError("packed entry requires a valid object id");
    let result: CompletePackedEntry | null = null;
    let rows = 0;
    for (const row of this.#db.iterate(
      `SELECT /* complete-packed-entry */ object.oid, object.pack_id,
              object.type, object.size, object.base_oid
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
        WHERE object.repo_id = ? AND object.oid = ?
        LIMIT 2`,
      this.#repoId,
      oid,
    )) {
      const rowOid = row.oid;
      const packId = row.pack_id;
      const type = row.type;
      const size = row.size;
      const baseOid = row.base_oid;
      if (
        typeof rowOid !== "string" ||
        rowOid !== oid ||
        !isOid(rowOid) ||
        typeof packId !== "number" ||
        !Number.isSafeInteger(packId) ||
        packId < 0 ||
        typeof type !== "string" ||
        !isObjectType(type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid)))
      ) {
        throw new CorruptError(`packed entry ${oid} has invalid metadata`);
      }
      rows++;
      if (rows > 1) throw new CorruptError(`packed entry ${oid} is not unique`);
      result = { packId, type, size, baseOid };
    }
    return result;
  }

  /** Delete a bounded set of complete packs; absent ids make retries idempotent. */
  deleteCompletePacks(packIds: readonly number[]): number {
    const ids = uniquePackIds(packIds, MAX_PACK_DELETE_BATCH);
    if (ids.length === 0) return 0;
    const requested = new Set(ids);
    const states = new Map<number, "pending" | "complete">();
    for (const row of this.#db.iterate(
      `SELECT pack_id, state FROM git_pack_meta
        WHERE repo_id = ? AND pack_id IN (SELECT value FROM json_each(?))`,
      this.#repoId,
      JSON.stringify(ids),
    )) {
      const packId = row.pack_id;
      const state = row.state;
      if (
        typeof packId !== "number" ||
        !Number.isSafeInteger(packId) ||
        packId < 0 ||
        (state !== "pending" && state !== "complete") ||
        !requested.has(packId) ||
        states.has(packId)
      ) {
        throw new CorruptError("complete pack deletion query returned an invalid row");
      }
      states.set(packId, state);
    }
    for (const [packId, state] of states) {
      if (state !== "complete") throw new GitError("EBUSY", `pack ${packId} is still pending`);
    }
    if (states.size === 0) return 0;
    this.#db.transactionSync(() => {
      const deletingPackIds = [...states.keys()];
      for (const packId of deletingPackIds) {
        this.#deletePack(packId, deletingPackIds);
      }
    });
    this.#clearCaches();
    return states.size;
  }

  #authenticateLooseDeltaBases(deletingPackId: number, deletingPackIds: readonly number[]): void {
    const bases: CompletePackObject[] = [];
    for (const row of this.#db.iterate(
      `SELECT DISTINCT base.oid, base.type, base.size,
              loose.oid AS loose_oid, loose.type AS loose_type, loose.size AS loose_size
         FROM git_pack_entries child
         JOIN git_pack_meta child_pack
           ON child_pack.repo_id = child.repo_id AND child_pack.pack_id = child.pack_id
          AND child_pack.state = 'complete'
         JOIN git_pack_objects base
           ON base.repo_id = child.repo_id AND base.oid = child.base_oid
          AND base.pack_id = ?
         LEFT JOIN git_objects loose
           ON loose.repo_id = base.repo_id AND loose.oid = base.oid
        WHERE child.repo_id = ?
          AND child.pack_id NOT IN (SELECT value FROM json_each(?))
        ORDER BY base.oid COLLATE BINARY LIMIT ?`,
      deletingPackId,
      this.#repoId,
      JSON.stringify(deletingPackIds),
      MAX_PACK_MEMBERSHIP_OBJECTS + 1,
    )) {
      if (bases.length >= MAX_PACK_MEMBERSHIP_OBJECTS) {
        throw new GitError("E2BIG", "surviving loose delta closure exceeds its object limit");
      }
      if (
        typeof row.oid !== "string" ||
        !isOid(row.oid) ||
        typeof row.type !== "string" ||
        !isObjectType(row.type) ||
        typeof row.size !== "number" ||
        !Number.isSafeInteger(row.size) ||
        row.size < 0 ||
        row.size > MAX_PACK_DELTA_WORKING_BYTES
      ) {
        throw new CorruptError(`pack ${deletingPackId}: delta base metadata is invalid`);
      }
      if (row.loose_oid === null) {
        throw new GitError(
          "EBUSY",
          `pack ${deletingPackId} is required by a surviving delta chain`,
        );
      }
      if (row.loose_oid !== row.oid || row.loose_type !== row.type || row.loose_size !== row.size) {
        throw new CorruptError(`pack ${deletingPackId}: surviving loose delta base is invalid`);
      }
      bases.push({ oid: row.oid, type: row.type, size: row.size });
    }
    if (bases.length === 0) return;
    this.#authenticateLooseObjects(deletingPackId, bases);
  }

  #authenticateLooseObjects(deletingPackId: number, objects: readonly CompletePackObject[]): void {
    let ordinal = 0;
    for (const row of this.#db.iterate(
      `SELECT input.key AS ordinal, loose.oid, loose.type, loose.size
         FROM json_each(?) input
         LEFT JOIN git_objects loose
           ON loose.repo_id = ? AND loose.oid = json_extract(input.value, '$.oid')
        ORDER BY input.key`,
      JSON.stringify(objects),
      this.#repoId,
    )) {
      const expected = objects[ordinal];
      if (
        expected === undefined ||
        row.ordinal !== ordinal ||
        row.oid !== expected.oid ||
        row.type !== expected.type ||
        row.size !== expected.size
      ) {
        throw new CorruptError(
          `pack ${deletingPackId}: surviving loose delta base metadata changed`,
        );
      }
      ordinal++;
    }
    if (ordinal !== objects.length) {
      throw new CorruptError(
        `pack ${deletingPackId}: surviving loose delta base authentication is incomplete`,
      );
    }
  }

  #deletePack(packId: number, deletingPackIds: readonly number[]): void {
    const encodedDeletingPackIds = JSON.stringify(deletingPackIds);
    const promotedOids = new Set<unknown>();
    for (const row of this.#db.iterate(
      `INSERT OR REPLACE INTO git_pack_objects
         (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid)
       SELECT candidate.repo_id, candidate.oid, candidate.pack_id, candidate.offset,
              candidate.data_off, candidate.data_len, candidate.type, candidate.size,
              candidate.entry_size, candidate.base_oid
         FROM git_pack_entries candidate
         JOIN git_pack_meta candidate_meta
           ON candidate_meta.repo_id = candidate.repo_id
          AND candidate_meta.pack_id = candidate.pack_id
          AND candidate_meta.state = 'complete'
        WHERE candidate.repo_id = ?
          AND candidate.pack_id NOT IN (SELECT value FROM json_each(?))
          AND EXISTS (
            SELECT 1 FROM git_pack_objects current
             WHERE current.repo_id = candidate.repo_id AND current.oid = candidate.oid
               AND current.pack_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries earlier
            JOIN git_pack_meta earlier_meta
              ON earlier_meta.repo_id = earlier.repo_id
             AND earlier_meta.pack_id = earlier.pack_id
             AND earlier_meta.state = 'complete'
             WHERE earlier.repo_id = candidate.repo_id AND earlier.oid = candidate.oid
               AND earlier.pack_id NOT IN (SELECT value FROM json_each(?))
               AND earlier.pack_id < candidate.pack_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_pack_entries same_pack
             WHERE same_pack.repo_id = candidate.repo_id
               AND same_pack.pack_id = candidate.pack_id
               AND same_pack.oid = candidate.oid
               AND same_pack.offset < candidate.offset
          )
       RETURNING oid, pack_id`,
      this.#repoId,
      encodedDeletingPackIds,
      packId,
      encodedDeletingPackIds,
    )) {
      if (
        promotedOids.has(row.oid) ||
        deletingPackIds.some((deletingPackId) => deletingPackId === row.pack_id)
      ) {
        throw new CorruptError(`pack ${packId}: promoted fallback row is invalid`);
      }
      promotedOids.add(row.oid);
    }
    this.#authenticateLooseDeltaBases(packId, deletingPackIds);
    this.#db.run(
      `DELETE FROM git_commits
        WHERE repo_id = ?
          AND oid IN (
            SELECT oid FROM git_pack_objects WHERE repo_id = ? AND pack_id = ? AND type = 'commit'
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_objects loose
             WHERE loose.repo_id = git_commits.repo_id
               AND loose.oid = git_commits.oid
               AND loose.type = 'commit'
               AND loose.size = git_commits.object_size
          )`,
      this.#repoId,
      this.#repoId,
      packId,
    );
    this.#db.run(
      `DELETE FROM git_tree_effective WHERE source_key IN (
         SELECT source_key FROM git_tree_sources
          WHERE repo_id = ? AND storage = 'pack' AND source_id = ?
       )`,
      this.#repoId,
      packId,
    );
    this.#db.run(
      `INSERT OR REPLACE INTO git_tree_effective (repo_id, tree_oid, source_key)
       SELECT object.repo_id, object.oid, source.source_key
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
         JOIN git_tree_sources source
           ON source.repo_id = object.repo_id AND source.tree_oid = object.oid
          AND source.storage = 'pack' AND source.source_id = object.pack_id
        WHERE object.repo_id = ? AND object.type = 'tree'
          AND EXISTS (
            SELECT 1 FROM git_tree_sources doomed
             WHERE doomed.repo_id = object.repo_id AND doomed.tree_oid = object.oid
               AND doomed.storage = 'pack' AND doomed.source_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM git_objects loose
             WHERE loose.repo_id = object.repo_id AND loose.oid = object.oid
               AND loose.type = 'tree'
          )`,
      this.#repoId,
      packId,
    );
    this.#db.run(
      "DELETE FROM git_tree_sources WHERE repo_id = ? AND storage = 'pack' AND source_id = ?",
      this.#repoId,
      packId,
    );
    for (const table of [
      "git_pack_data",
      "git_pack_entries",
      "git_pack_objects",
      "git_pack_pending",
      "git_pack_meta",
    ]) {
      this.#db.run(`DELETE FROM ${table} WHERE repo_id = ? AND pack_id = ?`, this.#repoId, packId);
    }
  }

  reservePending(
    nowMs: number,
    lifecycle: PackIngestLifecycle | undefined,
    ownership: { ordinary: boolean },
  ): { packId: number; lease: PackIngestLease | null; reclaimed: number } {
    let activePackId: number | undefined;
    try {
      return this.#db.transactionSync(() => {
        let control = this.#ensureIngestControl();
        let reclaimed = 0;
        if (ownership.ordinary) {
          const cleanup = this.#reclaimPendingRows(control, nowMs);
          control = cleanup.control;
          reclaimed = cleanup.removed;
          if (control.activePackId !== null) {
            throw new GitError("EBUSY", "pack ingest is active");
          }
          if (control.ownerGeneration === Number.MAX_SAFE_INTEGER) {
            throw new GitError("E2BIG", "pack ingest generation is exhausted");
          }
        }
        const packId = this.#nextPackId(control);
        this.#db.run(
          "INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created) VALUES (?, ?, 0, 0, 'pending', ?)",
          this.#repoId,
          packId,
          nowMs,
        );
        let lease: PackIngestLease | null = null;
        let updated: Record<string, unknown> | undefined;
        if (ownership.ordinary) {
          const generation = control.ownerGeneration + 1;
          updated = this.#db.one<Record<string, unknown>>(
            `UPDATE git_pack_ingest_control
                SET owner_generation = ?, last_pack_id = ?, active_pack_id = ?, expires_ms = ?
              WHERE repo_id = ?
            RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
            generation,
            packId,
            packId,
            nowMs + PACK_INGEST_LEASE_MS,
            this.#repoId,
          );
          lease = { generation, packId, expiresMs: nowMs + PACK_INGEST_LEASE_MS };
        } else {
          updated = this.#db.one<Record<string, unknown>>(
            `UPDATE git_pack_ingest_control SET last_pack_id = ? WHERE repo_id = ?
            RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
            packId,
            this.#repoId,
          );
        }
        if (
          updated === undefined ||
          requireIngestControl(updated, this.#repoId).lastPackId !== packId
        ) {
          throw new CorruptError("pack ingest allocation was not recorded");
        }
        this.#sharedState.activePending.add(packId);
        activePackId = packId;
        if (lifecycle !== undefined) {
          requireLifecycleResult(lifecycle.reserved(packId), "reserved");
        }
        return { packId, lease, reclaimed };
      });
    } catch (error) {
      if (activePackId !== undefined) this.#sharedState.activePending.delete(activePackId);
      throw error;
    }
  }

  renewIngestLease(lease: PackIngestLease, now: () => number): void {
    const nowMs = requireIngestTime(now);
    if (nowMs < lease.expiresMs - Math.floor(PACK_INGEST_LEASE_MS / 2)) return;
    const row = this.#db.one<Record<string, unknown>>(
      `UPDATE git_pack_ingest_control
          SET expires_ms = max(expires_ms, ?)
        WHERE repo_id = ? AND owner_generation = ? AND active_pack_id = ? AND expires_ms > ?
      RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
      nowMs + PACK_INGEST_LEASE_MS,
      this.#repoId,
      lease.generation,
      lease.packId,
      nowMs,
    );
    if (row === undefined) throw new GitError("ESTALE", "pack ingest ownership expired");
    const control = requireIngestControl(row, this.#repoId);
    if (
      control.ownerGeneration !== lease.generation ||
      control.activePackId !== lease.packId ||
      control.expiresMs === null ||
      control.expiresMs <= nowMs
    ) {
      throw new CorruptError("pack ingest lease renewal returned an invalid owner");
    }
    lease.expiresMs = control.expiresMs;
  }

  releaseIngestLease(lease: PackIngestLease, required: boolean, db: SqlDatabase = this.#db): void {
    const row = db.one<Record<string, unknown>>(
      `UPDATE git_pack_ingest_control
          SET active_pack_id = NULL, expires_ms = NULL
        WHERE repo_id = ? AND owner_generation = ? AND active_pack_id = ?
      RETURNING repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms`,
      this.#repoId,
      lease.generation,
      lease.packId,
    );
    if (row === undefined) {
      if (required) throw new GitError("ESTALE", "pack ingest ownership changed");
      return;
    }
    requireIngestControl(row, this.#repoId);
  }

  auditPublishedMembership(packId: number, expected: ExpectedPackMembership): void {
    const unavailable = this.#db.scalar<number>(
      `SELECT CASE WHEN count(*) != ? THEN -1
              ELSE coalesce(sum(CASE
                WHEN canonical.oid IS NULL OR owner.state IS NOT 'complete' THEN 1
                ELSE 0
              END), 0)
            END
         FROM git_pack_entries entry
         LEFT JOIN git_pack_objects canonical
           ON canonical.repo_id = entry.repo_id AND canonical.oid = entry.oid
         LEFT JOIN git_pack_meta owner
           ON owner.repo_id = canonical.repo_id AND owner.pack_id = canonical.pack_id
        WHERE entry.repo_id = ? AND entry.pack_id = ?`,
      expected.count,
      this.#repoId,
      packId,
    );
    if (unavailable !== 0) {
      throw new GitError("ESTALE", "pack membership was claimed by another ingest");
    }
  }
}
