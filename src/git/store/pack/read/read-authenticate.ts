// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "../../../../db/db.js";
import { isOid, toHex } from "../../../common/bytes.js";
import { CorruptError, GitError } from "../../../common/errors.js";
import { hashObject, type ObjectType, objectHeader } from "../../../common/objects.js";
import { Sha1 } from "../../../common/sha1.js";
import { InflateStream } from "../../../common/zlib.js";
import {
  type AuthenticatedPackSource,
  isObjectType,
  MAX_PACK_DELTA_WORKING_BYTES,
  MAX_PACK_MEMBERSHIP_OBJECTS,
  PACK_BLOB_BATCH_TARGET_BYTES,
  PACK_READ_BYTES,
} from "../shared.js";
import type { PackDataReader } from "./read-data.js";
import type { PackObjectResolver } from "./read-resolver.js";

export class PackSourceAuthenticator {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly resolver: PackObjectResolver,
    private readonly data: PackDataReader,
  ) {}
  authenticateCompleteSources(
    objects: readonly { oid: string; type: ObjectType; size: number; packId: number }[],
  ): void {
    if (objects.length < 1 || objects.length > MAX_PACK_MEMBERSHIP_OBJECTS) {
      throw new GitError(
        "E2BIG",
        `packed source authentication exceeds ${MAX_PACK_MEMBERSHIP_OBJECTS} objects`,
      );
    }
    const requested = new Set<string>();
    for (const object of objects) {
      if (
        !isOid(object.oid) ||
        !isObjectType(object.type) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        !Number.isSafeInteger(object.packId) ||
        object.packId < 0
      ) {
        throw new CorruptError("canonical packed source request is invalid");
      }
      if (requested.has(object.oid)) {
        throw new CorruptError("canonical packed source request contains a duplicate object id");
      }
      requested.add(object.oid);
    }
    const encoded = JSON.stringify(objects);
    let sources = 0;
    const authenticated: AuthenticatedPackSource[] = [];
    for (const row of this.db.iterate(
      `SELECT CAST(input.key AS INTEGER) AS ordinal,
              json_extract(input.value, '$.oid') AS expected_oid,
              json_extract(input.value, '$.type') AS expected_type,
              json_extract(input.value, '$.size') AS expected_size,
              json_extract(input.value, '$.packId') AS expected_pack_id,
              canonical.oid, canonical.type, canonical.size, canonical.pack_id,
              canonical.data_off, canonical.data_len, canonical.entry_size,
              canonical.base_oid, pack.state, pack.size AS pack_size,
              EXISTS (
                SELECT 1 FROM git_pack_entries physical
                 WHERE physical.repo_id = canonical.repo_id
                   AND physical.oid = canonical.oid
                   AND physical.pack_id = canonical.pack_id
                   AND physical.offset IS canonical.offset
                   AND physical.data_off IS canonical.data_off
                   AND physical.data_len IS canonical.data_len
                   AND physical.type IS canonical.type
                   AND physical.size IS canonical.size
                   AND physical.entry_size IS canonical.entry_size
                   AND physical.base_oid IS canonical.base_oid
              ) AS exact_source
         FROM json_each(?) input
         LEFT JOIN git_pack_objects canonical
           ON canonical.repo_id = ? AND canonical.oid = json_extract(input.value, '$.oid')
         LEFT JOIN git_pack_meta pack
           ON pack.repo_id = canonical.repo_id AND pack.pack_id = canonical.pack_id
        ORDER BY CAST(input.key AS INTEGER)`,
      encoded,
      this.repoId,
    )) {
      const expected = objects[sources];
      if (
        expected === undefined ||
        row.ordinal !== sources ||
        row.expected_oid !== expected.oid ||
        row.expected_type !== expected.type ||
        row.expected_size !== expected.size ||
        row.expected_pack_id !== expected.packId ||
        row.oid !== expected.oid ||
        row.type !== expected.type ||
        row.size !== expected.size ||
        row.pack_id !== expected.packId ||
        row.state !== "complete" ||
        row.exact_source !== 1 ||
        typeof row.data_off !== "number" ||
        !Number.isSafeInteger(row.data_off) ||
        row.data_off < 0 ||
        typeof row.data_len !== "number" ||
        !Number.isSafeInteger(row.data_len) ||
        row.data_len < 1 ||
        typeof row.entry_size !== "number" ||
        !Number.isSafeInteger(row.entry_size) ||
        row.entry_size < 0 ||
        row.entry_size > MAX_PACK_DELTA_WORKING_BYTES ||
        (row.base_oid !== null && (typeof row.base_oid !== "string" || !isOid(row.base_oid))) ||
        typeof row.pack_size !== "number" ||
        !Number.isSafeInteger(row.pack_size) ||
        row.pack_size < 32 ||
        !Number.isSafeInteger(row.data_off + row.data_len) ||
        row.data_off + row.data_len > row.pack_size - 20 ||
        (row.base_oid === null && row.entry_size !== expected.size)
      ) {
        throw new CorruptError("canonical packed source changed before authentication");
      }
      authenticated.push({
        oid: expected.oid,
        type: expected.type,
        size: expected.size,
        packId: expected.packId,
        dataOff: row.data_off,
        dataLen: row.data_len,
        entrySize: row.entry_size,
        baseOid: row.base_oid,
      });
      sources++;
    }
    if (sources !== objects.length) {
      throw new CorruptError("canonical packed source authentication is incomplete");
    }

    let page: AuthenticatedPackSource[] = [];
    let pageBytes = 0;
    const authenticatePage = (): void => {
      if (page.length === 0) return;
      const only = page.length === 1 ? page[0] : undefined;
      if (
        only !== undefined &&
        only.dataLen > PACK_BLOB_BATCH_TARGET_BYTES &&
        only.baseOid === null
      ) {
        this.#authenticateFullPackSourceStreaming(
          only,
          "canonical packed source bytes disagree with their object id",
        );
        page = [];
        pageBytes = 0;
        return;
      }
      const read = this.resolver.readObjectsBounded(
        page.map((object) => object.oid),
        only?.packId ?? null,
        null,
        false,
        new Map(),
        true,
      );
      if (read.size !== page.length) {
        throw new CorruptError("canonical packed source authentication is incomplete");
      }
      for (const expected of page) {
        const object = read.get(expected.oid);
        if (
          object === undefined ||
          object.type !== expected.type ||
          object.data.length !== expected.size ||
          hashObject(object.type, object.data) !== expected.oid
        ) {
          throw new CorruptError("canonical packed source bytes disagree with their object id");
        }
      }
      page = [];
      pageBytes = 0;
    };
    for (const object of authenticated) {
      if (
        page.length > 0 &&
        (object.size > PACK_BLOB_BATCH_TARGET_BYTES - pageBytes ||
          object.dataLen > PACK_BLOB_BATCH_TARGET_BYTES)
      ) {
        authenticatePage();
      }
      page.push(object);
      pageBytes += object.size;
      if (
        object.size > PACK_BLOB_BATCH_TARGET_BYTES ||
        object.dataLen > PACK_BLOB_BATCH_TARGET_BYTES
      ) {
        authenticatePage();
      }
    }
    authenticatePage();
  }

  #authenticateFullPackSourceStreaming(source: AuthenticatedPackSource, message: string): void {
    if (source.baseOid !== null || source.entrySize !== source.size || source.dataLen < 1) {
      throw new CorruptError(message);
    }
    const sha = new Sha1().update(objectHeader(source.type, source.size));
    let produced = 0;
    const stream = new InflateStream((chunk) => {
      produced += chunk.length;
      if (produced > source.size) throw new CorruptError(message);
      sha.update(chunk);
    });
    let consumed = 0;
    try {
      while (!stream.ended && consumed < source.dataLen) {
        const length = Math.min(PACK_READ_BYTES, source.dataLen - consumed);
        const input = this.data.readRawUncached(source.packId, source.dataOff + consumed, length);
        const used = stream.push(input);
        consumed += used;
        if (!stream.ended && used !== input.length) throw new CorruptError(message);
      }
    } catch (error) {
      if (error instanceof CorruptError) throw error;
      throw new CorruptError(message, { cause: error });
    }
    if (
      !stream.ended ||
      consumed !== source.dataLen ||
      produced !== source.size ||
      toHex(sha.digest()) !== source.oid
    ) {
      throw new CorruptError(message);
    }
  }
}
