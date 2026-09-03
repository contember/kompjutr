// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { readBlob, type SqlDatabase } from "../../../db/db.js";
import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import type { ObjectType, RawObject } from "../../common/objects.js";
import { applyDelta } from "./delta.js";
import type { PackDataReader } from "./read-data.js";
import { PackGraphPager } from "./read-graph.js";
import {
  type CompressedEntry,
  checkDeltaInflateBudget,
  checkedPackBytes,
  type ExternalBatchResolver,
  type ExternalMetadataResolver,
  type ExternalObjectMetadata,
  isObjectType,
  isPackGraphLimit,
  MAX_PACK_BLOB_GRAPH_ENTRIES,
  MAX_PACK_BLOB_INPUTS,
  MAX_PACK_DELTA_WORKING_BYTES,
  PACK_BLOB_BATCH_TARGET_BYTES,
  PACK_CHUNK,
  type PackedEntry,
  validateDeltaWorkingSet,
} from "./shared.js";

export class PackObjectResolver {
  readonly #pager: PackGraphPager;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly externalBatch: ExternalBatchResolver,
    private readonly externalMetadata: ExternalMetadataResolver,
    private readonly objects: ByteLru<string, RawObject>,
    private readonly data: PackDataReader,
    private readonly maxDeltaDepth: number,
    private readonly graphPageEntries: number,
  ) {
    this.#pager = new PackGraphPager(
      db,
      repoId,
      maxDeltaDepth,
      graphPageEntries,
      (oids, pendingPackId, expectedType, allowMissing, seeds, bypassCache, graphEntryLimit) =>
        this.#readObjects(
          oids,
          pendingPackId,
          expectedType,
          allowMissing,
          seeds,
          bypassCache,
          graphEntryLimit,
        ),
    );
  }

  readObjectsBounded(
    oids: readonly string[],
    pendingPackId: number | null,
    expectedType: ObjectType | null,
    allowMissing: boolean,
    seeds: ReadonlyMap<string, RawObject>,
    bypassCache: boolean,
  ): Map<string, RawObject> {
    try {
      return this.#readObjects(oids, pendingPackId, expectedType, allowMissing, seeds, bypassCache);
    } catch (error) {
      if (!isPackGraphLimit(error)) throw error;
    }
    return this.#pager.readObjectsPaged(
      oids,
      pendingPackId,
      expectedType,
      allowMissing,
      seeds,
      bypassCache,
    );
  }

  /** Resolve requested objects in one bounded graph and physical pack cursor. */
  #readObjects(
    oids: readonly string[],
    pendingPackId: number | null,
    expectedType: ObjectType | null,
    allowMissing: boolean,
    seeds: ReadonlyMap<string, RawObject> = new Map(),
    bypassCache = false,
    graphEntryLimit = this.graphPageEntries,
  ): Map<string, RawObject> {
    if (
      !Number.isSafeInteger(graphEntryLimit) ||
      graphEntryLimit < 1 ||
      graphEntryLimit > MAX_PACK_BLOB_GRAPH_ENTRIES
    ) {
      throw new CorruptError("packed blob graph entry limit is invalid");
    }
    const wanted = [...new Set(oids)];
    if (wanted.length === 0) return new Map();
    if (wanted.length > MAX_PACK_BLOB_INPUTS) {
      throw new GitError("E2BIG", `blob batch exceeds ${MAX_PACK_BLOB_INPUTS} packed inputs`);
    }

    const rows = this.db.iterate(
      `WITH RECURSIVE
         roots(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
         seeds(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
         reachable(oid) AS (
           SELECT o.oid
             FROM roots r
             CROSS JOIN git_pack_objects o
             CROSS JOIN git_pack_meta m
            WHERE o.repo_id = ? AND o.oid = r.oid
              AND m.repo_id = o.repo_id AND m.pack_id = o.pack_id
              AND (m.state = 'complete' OR o.pack_id = ?)
           UNION
           SELECT base.oid
             FROM reachable r
             CROSS JOIN git_pack_objects child
             CROSS JOIN git_pack_meta child_meta
             CROSS JOIN git_pack_objects base
             CROSS JOIN git_pack_meta base_meta
            WHERE child.repo_id = ? AND child.oid = r.oid
              AND child_meta.repo_id = child.repo_id
              AND child_meta.pack_id = child.pack_id
              AND (child_meta.state = 'complete' OR child.pack_id = ?)
              AND base.repo_id = child.repo_id AND base.oid = child.base_oid
              AND base_meta.repo_id = base.repo_id
               AND base_meta.pack_id = base.pack_id
               AND (base_meta.state = 'complete' OR base.pack_id = ?)
               AND NOT EXISTS (SELECT 1 FROM seeds WHERE seeds.oid = base.oid)
             LIMIT ${graphEntryLimit + 1}
          )
       SELECT o.oid, o.pack_id, o.offset, o.data_off, o.data_len, o.type,
              o.size, o.entry_size, o.base_oid
         FROM reachable r
         CROSS JOIN git_pack_objects o
        WHERE o.repo_id = ? AND o.oid = r.oid`,
      JSON.stringify(wanted),
      JSON.stringify([...seeds.keys()]),
      this.repoId,
      pendingPackId ?? -1,
      this.repoId,
      pendingPackId ?? -1,
      pendingPackId ?? -1,
      this.repoId,
    );

    const entries = new Map<string, PackedEntry>();
    let rowCount = 0;
    for (const row of rows) {
      rowCount++;
      if (rowCount > graphEntryLimit) {
        throw new GitError("E2BIG", "packed blob dependency graph exceeds the bounded entry limit");
      }
      const oid = row.oid;
      const packId = row.pack_id;
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
        typeof packId !== "number" ||
        !Number.isSafeInteger(packId) ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        typeof dataOff !== "number" ||
        !Number.isSafeInteger(dataOff) ||
        typeof dataLen !== "number" ||
        !Number.isSafeInteger(dataLen) ||
        typeof type !== "string" ||
        !isObjectType(type) ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        typeof entrySize !== "number" ||
        !Number.isSafeInteger(entrySize) ||
        packId < 0 ||
        offset < 0 ||
        dataOff < 0 ||
        dataLen < 0 ||
        !Number.isSafeInteger(dataOff + dataLen) ||
        size < 0 ||
        entrySize < 0 ||
        entrySize > MAX_PACK_DELTA_WORKING_BYTES ||
        (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid)))
      ) {
        throw new CorruptError("packed blob index contains invalid metadata");
      }
      entries.set(oid, {
        oid,
        packId,
        offset,
        dataOff,
        dataLen,
        type,
        size,
        entrySize,
        baseOid,
      });
    }
    const available: string[] = [];
    for (const oid of wanted) {
      const entry = entries.get(oid);
      if (entry === undefined) {
        if (allowMissing) continue;
        throw new CorruptError(`packed object ${oid} has no visible source`);
      }
      if (expectedType !== null && entry.type !== expectedType) {
        throw new CorruptError(`${oid} is a ${entry.type}, not a ${expectedType}`);
      }
      available.push(oid);
    }
    const needed = new Map<string, PackedEntry>();
    const externalOids = new Set<string>();
    for (const oid of available) {
      let current = entries.get(oid)!;
      if (
        !bypassCache &&
        this.objects.get(this.data.objectCacheKey(current.packId, oid)) !== undefined
      ) {
        continue;
      }
      const seen = new Set<string>();
      let depth = 0;
      for (;;) {
        if (seen.has(current.oid)) throw new CorruptError(`cyclic delta chain at ${current.oid}`);
        seen.add(current.oid);
        needed.set(current.oid, current);
        if (current.baseOid === null) break;
        if (depth >= this.maxDeltaDepth) {
          throw new CorruptError(`delta chain deeper than ${this.maxDeltaDepth} at ${oid}`);
        }
        depth++;
        const next = entries.get(current.baseOid);
        if (next === undefined) {
          if (seeds.has(current.baseOid)) break;
          externalOids.add(current.baseOid);
          break;
        }
        if (
          !bypassCache &&
          this.objects.get(this.data.objectCacheKey(next.packId, next.oid)) !== undefined
        ) {
          break;
        }
        current = next;
      }
    }

    let compressedBytes = 0;
    const streamedCompressed = new Set<string>();
    const compressed = new Map<string, CompressedEntry>();
    const consumers = new Map<string, { entry: PackedEntry; output: CompressedEntry }[]>();
    for (const entry of needed.values()) {
      if (entry.dataLen > PACK_BLOB_BATCH_TARGET_BYTES - compressedBytes) {
        streamedCompressed.add(entry.oid);
        continue;
      }
      compressedBytes = checkedPackBytes(compressedBytes, entry.dataLen, "compressed input");
    }
    for (const entry of needed.values()) {
      if (streamedCompressed.has(entry.oid)) continue;
      const output = { bytes: new Uint8Array(entry.dataLen), filled: 0 };
      compressed.set(entry.oid, output);
      if (entry.dataLen === 0) continue;
      const first = Math.floor(entry.dataOff / PACK_CHUNK);
      const last = Math.floor((entry.dataOff + entry.dataLen - 1) / PACK_CHUNK);
      for (let seq = first; seq <= last; seq++) {
        const key = `${entry.packId}:${seq}`;
        const list = consumers.get(key);
        const consumer = { entry, output };
        if (list === undefined) consumers.set(key, [consumer]);
        else list.push(consumer);
      }
    }

    const copyChunk = (packId: number, seq: number, chunk: Uint8Array): void => {
      for (const { entry, output } of consumers.get(`${packId}:${seq}`) ?? []) {
        const chunkStart = seq * PACK_CHUNK;
        const from = Math.max(entry.dataOff, chunkStart);
        const to = Math.min(entry.dataOff + entry.dataLen, chunkStart + chunk.length);
        if (to <= from) continue;
        const target = from - entry.dataOff;
        output.bytes.set(chunk.subarray(from - chunkStart, to - chunkStart), target);
        output.filled += to - from;
      }
    };

    const missingChunks: { p: number; q: number }[] = [];
    for (const key of consumers.keys()) {
      const separator = key.indexOf(":");
      const packId = Number(key.slice(0, separator));
      const seq = Number(key.slice(separator + 1));
      const hit = bypassCache ? undefined : this.data.getCachedChunk(packId, seq);
      if (hit === undefined) missingChunks.push({ p: packId, q: seq });
      else copyChunk(packId, seq, hit);
    }
    missingChunks.sort((left, right) => left.p - right.p || left.q - right.q);
    const returned = new Set<string>();
    if (missingChunks.length > 0) {
      for (const row of this.db.iterate(
        `WITH requested(pack_id, seq) AS (
           SELECT json_extract(value, '$.p'), json_extract(value, '$.q') FROM json_each(?)
         )
         SELECT d.pack_id, d.seq, d.data
           FROM requested r
           JOIN git_pack_data d
             ON d.repo_id = ? AND d.pack_id = r.pack_id AND d.seq = r.seq
          WHERE length(d.data) <= ${PACK_CHUNK}
          ORDER BY d.pack_id, d.seq`,
        JSON.stringify(missingChunks),
        this.repoId,
      )) {
        if (!Number.isSafeInteger(row.pack_id) || !Number.isSafeInteger(row.seq)) {
          throw new CorruptError("pack chunk query returned invalid coordinates");
        }
        const packId = Number(row.pack_id);
        const seq = Number(row.seq);
        const data = readBlob(row.data);
        const key = `${packId}:${seq}`;
        returned.add(key);
        if (!bypassCache) this.data.cacheChunk(packId, seq, data);
        copyChunk(packId, seq, data);
      }
    }
    for (const chunk of missingChunks) {
      if (!returned.has(`${chunk.p}:${chunk.q}`)) {
        throw new CorruptError(`pack ${chunk.p}: missing chunk ${chunk.q}`);
      }
    }
    for (const [oid, value] of compressed) {
      if (value.filled !== value.bytes.length) {
        throw new CorruptError(`packed blob entry ${oid} exceeds its stored chunks`);
      }
    }

    const externalMetadata = new Map<string, ExternalObjectMetadata>();
    if (externalOids.size > 0) {
      const resolvedMetadata = this.externalMetadata([...externalOids]);
      for (const oid of externalOids) {
        const object = resolvedMetadata.get(oid);
        if (object === undefined) continue;
        if (!isObjectType(object.type) || !Number.isSafeInteger(object.size) || object.size < 0) {
          throw new CorruptError("loose base metadata is invalid");
        }
        externalMetadata.set(oid, object);
      }
    }
    let external = new Map<string, RawObject>();
    if (externalMetadata.size > 0) {
      external = this.externalBatch([...externalMetadata.keys()]);
    }
    for (const [oid, object] of external) {
      const metadata = externalMetadata.get(oid);
      if (
        metadata === undefined ||
        metadata.type !== object.type ||
        metadata.size !== object.data.length
      ) {
        throw new CorruptError("materialized loose base disagrees with its admitted metadata");
      }
    }
    const result = new Map<string, RawObject>();
    const resolved = new Map<string, RawObject>();
    for (const oid of available) {
      const first = entries.get(oid)!;
      const cached =
        resolved.get(oid) ??
        (bypassCache ? undefined : this.objects.get(this.data.objectCacheKey(first.packId, oid)));
      if (cached !== undefined) {
        result.set(oid, cached);
        continue;
      }
      const chain: PackedEntry[] = [];
      const seen = new Set<string>();
      let current = first;
      let object: RawObject | undefined;
      for (;;) {
        if (seen.has(current.oid)) throw new CorruptError(`cyclic delta chain at ${current.oid}`);
        seen.add(current.oid);
        const resolvedBase = resolved.get(current.oid);
        if (resolvedBase !== undefined) {
          object = resolvedBase;
          break;
        }
        if (current.baseOid === null) {
          if (current.entrySize !== current.size) {
            throw new CorruptError(
              `pack entry at ${current.offset} has inconsistent size metadata`,
            );
          }
          object = {
            type: current.type,
            data: this.data.inflateCompressed(
              current,
              compressed.get(current.oid)?.bytes,
              streamedCompressed.has(current.oid),
              bypassCache,
            ),
          };
          resolved.set(current.oid, object);
          if (!bypassCache) this.data.cacheObject(current.packId, current.oid, object);
          break;
        }
        if (chain.length >= this.maxDeltaDepth) {
          throw new CorruptError(`delta chain deeper than ${this.maxDeltaDepth} at ${oid}`);
        }
        chain.push(current);
        const next = entries.get(current.baseOid);
        if (next === undefined) {
          const seeded = seeds.get(current.baseOid);
          object = seeded ?? external.get(current.baseOid);
          if (object === undefined) {
            throw new CorruptError(`missing delta base ${current.baseOid} for ${current.oid}`);
          }
          break;
        }
        const cachedBase = bypassCache
          ? undefined
          : this.objects.get(this.data.objectCacheKey(next.packId, next.oid));
        if (cachedBase !== undefined) {
          object = cachedBase;
          break;
        }
        current = next;
      }
      if (object === undefined) {
        throw new CorruptError(`packed object ${oid} did not resolve a base`);
      }
      let resolvedObject = object;
      for (let index = chain.length - 1; index >= 0; index--) {
        const entry = chain[index]!;
        checkDeltaInflateBudget(resolvedObject.data, entry.entrySize);
        const delta = this.data.inflateCompressed(
          entry,
          compressed.get(entry.oid)?.bytes,
          streamedCompressed.has(entry.oid),
          bypassCache,
        );
        const targetSize = validateDeltaWorkingSet(resolvedObject.data, delta, entry.size);
        const target: RawObject = {
          type: resolvedObject.type,
          data: applyDelta(resolvedObject.data, delta),
        };
        if (targetSize !== target.data.length) {
          throw new CorruptError(`pack entry at ${entry.offset} has inconsistent size metadata`);
        }
        resolvedObject = target;
        resolved.set(entry.oid, resolvedObject);
        if (resolvedObject.data.length !== entry.size || resolvedObject.type !== entry.type) {
          throw new CorruptError(`pack entry at ${entry.offset} has inconsistent type or size`);
        }
        if (!bypassCache) this.data.cacheObject(entry.packId, entry.oid, resolvedObject);
      }
      if (resolvedObject.type !== first.type || resolvedObject.data.length !== first.size) {
        throw new CorruptError(`packed object ${oid} has inconsistent type or size`);
      }
      result.set(oid, resolvedObject);
      resolved.set(oid, resolvedObject);
    }
    return result;
  }
}
