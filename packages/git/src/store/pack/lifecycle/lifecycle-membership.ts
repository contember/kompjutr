// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../../common/bytes.js";
import { CorruptError, GitError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";
import {
  type CompletePackedEntry,
  type CompletePackObject,
  isObjectType,
  MAX_PACK_MEMBERSHIP_OBJECTS,
  requirePackId,
} from "../shared.js";

export class PackMembershipReader {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
  ) {}

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
    const meta = this.db.one<{ state: unknown; count: unknown; size: unknown }>(
      "SELECT state, count, size FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
      this.repoId,
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
    for (const row of this.db.iterate(
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
      this.repoId,
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
    for (const row of this.db.iterate(
      `SELECT /* complete-packed-entry */ object.oid, object.pack_id,
              object.type, object.size, object.base_oid
         FROM git_pack_objects object
         JOIN git_pack_meta pack
           ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
          AND pack.state = 'complete'
        WHERE object.repo_id = ? AND object.oid = ?
        LIMIT 2`,
      this.repoId,
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
}
