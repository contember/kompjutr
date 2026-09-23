// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { readBlob, type SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../../common/bytes.js";
import { CorruptError, GitError } from "../../../common/errors.js";
import type { ByteLru } from "../../../common/lru.js";
import type { ObjectType, RawObject } from "../../../common/objects.js";
import { int, nullable, oneOf, RowShape, text } from "../../../common/rows.js";
import { applyDelta } from "../delta.js";
import {
  type CompressedEntry,
  checkDeltaInflateBudget,
  checkedPackBytes,
  isPackGraphLimit,
  MAX_PACK_BLOB_GRAPH_ENTRIES,
  MAX_PACK_BLOB_INPUTS,
  MAX_PACK_DELTA_WORKING_BYTES,
  PACK_BLOB_BATCH_TARGET_BYTES,
  PACK_CHUNK,
  PACK_GRAPH_LIMIT_MESSAGE,
  type PackedEntry,
  validateDeltaWorkingSet,
} from "../shared.js";
import type { PackDataReader } from "./read-data.js";
import { PackGraphPager } from "./read-graph.js";
import {
  PACK_GRAPH_BASE_STEP,
  PACK_GRAPH_ENTRY_SELECT,
  packGraphStartsSql,
} from "./read-graph-sql.js";

const INVALID_ENTRY = "packed blob index contains invalid metadata";
const INVALID_CHUNK = "pack chunk query returned invalid coordinates";

const PACKED_ENTRY_ROW = new RowShape(
  {
    oid: text(INVALID_ENTRY).where(isOid, INVALID_ENTRY),
    pack_id: int(0, Number.MAX_SAFE_INTEGER, INVALID_ENTRY),
    offset: int(0, Number.MAX_SAFE_INTEGER, INVALID_ENTRY),
    data_off: int(0, Number.MAX_SAFE_INTEGER, INVALID_ENTRY),
    data_len: int(0, Number.MAX_SAFE_INTEGER, INVALID_ENTRY),
    type: oneOf(["blob", "tree", "commit", "tag"], INVALID_ENTRY),
    size: int(0, Number.MAX_SAFE_INTEGER, INVALID_ENTRY),
    entry_size: int(0, MAX_PACK_DELTA_WORKING_BYTES, INVALID_ENTRY),
    base_offset: nullable(int(0, Number.MAX_SAFE_INTEGER, INVALID_ENTRY)),
    base_oid: nullable(text(INVALID_ENTRY).where(isOid, INVALID_ENTRY)),
    start: int(0, 1, INVALID_ENTRY),
  },
  INVALID_ENTRY,
);

/** A graph entry carries its in-pack base's OID so a seeded base ends the walk. */
interface GraphEntry extends PackedEntry {
  baseOid: string | null;
  start: boolean;
}

function entryKey(packId: number, offset: number): string {
  return `${packId}:${offset}`;
}

const CHUNK_COORDINATES_ROW = new RowShape(
  {
    pack_id: int(0, Number.MAX_SAFE_INTEGER, INVALID_CHUNK),
    seq: int(0, Number.MAX_SAFE_INTEGER, INVALID_CHUNK),
  },
  INVALID_CHUNK,
);

function decodePackedEntry(row: Record<string, unknown>): GraphEntry {
  const decoded = PACKED_ENTRY_ROW.decode(row);
  // The entry is addressed as [data_off, data_off + data_len); an inexact sum would misread it.
  if (!Number.isSafeInteger(decoded.data_off + decoded.data_len)) {
    throw new CorruptError(INVALID_ENTRY);
  }
  return {
    oid: decoded.oid,
    packId: decoded.pack_id,
    offset: decoded.offset,
    dataOff: decoded.data_off,
    dataLen: decoded.data_len,
    type: decoded.type,
    size: decoded.size,
    entrySize: decoded.entry_size,
    baseOffset: decoded.base_offset,
    baseOid: decoded.base_oid,
    start: decoded.start === 1,
  };
}

export class PackObjectResolver {
  readonly #pager: PackGraphPager;

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
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

  #deltaDepthExceeded(oid: string): CorruptError {
    return new CorruptError(`delta chain deeper than ${this.maxDeltaDepth} at ${oid}`);
  }

  /**
   * Discover the bounded delta closure of `wanted`: each chain start, then its
   * in-pack bases by offset. Keys are physical, since one OID can sit in
   * several packs of the closure.
   */
  #readGraph(
    wanted: readonly string[],
    seeds: ReadonlyMap<string, RawObject>,
    pendingPackId: number | null,
    graphEntryLimit: number,
  ): Map<string, GraphEntry> {
    const rows = this.db.iterate(
      `WITH RECURSIVE
         roots(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
         seeds(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
         ${packGraphStartsSql("roots")},
         reachable(pack_id, offset) AS (
           SELECT pack_id, offset FROM starts
           UNION
           ${PACK_GRAPH_BASE_STEP}
            LIMIT ${graphEntryLimit + 1}
         )
       ${PACK_GRAPH_ENTRY_SELECT}`,
      JSON.stringify(wanted),
      JSON.stringify([...seeds.keys()]),
      this.repoId,
      pendingPackId ?? -1,
      this.repoId,
      pendingPackId ?? -1,
      this.repoId,
      this.repoId,
    );

    const entries = new Map<string, GraphEntry>();
    let rowCount = 0;
    for (const row of rows) {
      rowCount++;
      if (rowCount > graphEntryLimit) throw new GitError("E2BIG", PACK_GRAPH_LIMIT_MESSAGE);
      const entry = decodePackedEntry(row);
      entries.set(entryKey(entry.packId, entry.offset), entry);
    }
    return entries;
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

    const entries = this.#readGraph(wanted, seeds, pendingPackId, graphEntryLimit);
    const cachedObject = (entry: PackedEntry): RawObject | undefined =>
      bypassCache ? undefined : this.objects.get(this.data.objectCacheKey(entry.packId, entry.oid));

    const byOid = new Map<string, GraphEntry>();
    for (const entry of entries.values()) {
      if (entry.start) byOid.set(entry.oid, entry);
    }
    const baseOf = (entry: GraphEntry): GraphEntry | undefined =>
      entry.baseOffset === null ? undefined : entries.get(entryKey(entry.packId, entry.baseOffset));

    const available: string[] = [];
    for (const oid of wanted) {
      const entry = byOid.get(oid);
      if (entry === undefined) {
        if (allowMissing) continue;
        throw new CorruptError(`packed object ${oid} has no visible source`);
      }
      if (expectedType !== null && entry.type !== expectedType) {
        throw new CorruptError(`${oid} is a ${entry.type}, not a ${expectedType}`);
      }
      available.push(oid);
    }
    const needed = new Map<string, GraphEntry>();
    for (const oid of available) {
      let current = byOid.get(oid)!;
      if (cachedObject(current) !== undefined) continue;
      const seen = new Set<string>();
      let depth = 0;
      for (;;) {
        const key = entryKey(current.packId, current.offset);
        if (seen.has(key)) throw new CorruptError(`cyclic delta chain at ${current.oid}`);
        seen.add(key);
        needed.set(key, current);
        if (current.baseOffset === null) break;
        if (depth >= this.maxDeltaDepth) throw this.#deltaDepthExceeded(oid);
        depth++;
        const next = baseOf(current);
        if (next === undefined || cachedObject(next) !== undefined) break;
        current = next;
      }
    }

    let compressedBytes = 0;
    const streamedCompressed = new Set<string>();
    const compressed = new Map<string, CompressedEntry>();
    const consumers = new Map<string, { entry: PackedEntry; output: CompressedEntry }[]>();
    for (const [key, entry] of needed) {
      if (entry.dataLen > PACK_BLOB_BATCH_TARGET_BYTES - compressedBytes) {
        streamedCompressed.add(key);
        continue;
      }
      compressedBytes = checkedPackBytes(compressedBytes, entry.dataLen, "compressed input");
    }
    for (const [key, entry] of needed) {
      if (streamedCompressed.has(key)) continue;
      const output = { bytes: new Uint8Array(entry.dataLen), filled: 0 };
      compressed.set(key, output);
      if (entry.dataLen === 0) continue;
      const first = Math.floor(entry.dataOff / PACK_CHUNK);
      const last = Math.floor((entry.dataOff + entry.dataLen - 1) / PACK_CHUNK);
      for (let seq = first; seq <= last; seq++) {
        const chunkKey = `${entry.packId}:${seq}`;
        const list = consumers.get(chunkKey);
        const consumer = { entry, output };
        if (list === undefined) consumers.set(chunkKey, [consumer]);
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
        const { pack_id: packId, seq } = CHUNK_COORDINATES_ROW.decode(row);
        const data = readBlob(row.data);
        returned.add(`${packId}:${seq}`);
        if (!bypassCache) this.data.cacheChunk(packId, seq, data);
        copyChunk(packId, seq, data);
      }
    }
    for (const chunk of missingChunks) {
      if (!returned.has(`${chunk.p}:${chunk.q}`)) {
        throw new CorruptError(`pack ${chunk.p}: missing chunk ${chunk.q}`);
      }
    }
    for (const [key, value] of compressed) {
      if (value.filled !== value.bytes.length) {
        throw new CorruptError(
          `packed blob entry ${needed.get(key)?.oid} exceeds its stored chunks`,
        );
      }
    }

    const result = new Map<string, RawObject>();
    const inflate = (entry: PackedEntry): Uint8Array => {
      const key = entryKey(entry.packId, entry.offset);
      return this.data.inflateCompressed(
        entry,
        compressed.get(key)?.bytes,
        !compressed.has(key),
        bypassCache,
      );
    };
    const materializeBase = (entry: PackedEntry): RawObject => {
      if (entry.entrySize !== entry.size) {
        throw new CorruptError(`pack entry at ${entry.offset} has inconsistent size metadata`);
      }
      const object: RawObject = { type: entry.type, data: inflate(entry) };
      if (!bypassCache) this.data.cacheObject(entry.packId, entry.oid, object);
      return object;
    };
    for (const oid of available) {
      const first = byOid.get(oid)!;
      const hit = result.get(oid) ?? cachedObject(first);
      if (hit !== undefined) {
        result.set(oid, hit);
        continue;
      }
      const chain: PackedEntry[] = [];
      const seen = new Set<string>();
      let current = first;
      let object: RawObject | undefined;
      for (;;) {
        const key = entryKey(current.packId, current.offset);
        if (seen.has(key)) throw new CorruptError(`cyclic delta chain at ${current.oid}`);
        seen.add(key);
        object = result.get(current.oid) ?? cachedObject(current);
        if (object !== undefined) break;
        if (current.baseOffset === null) {
          object = materializeBase(current);
          break;
        }
        if (chain.length >= this.maxDeltaDepth) throw this.#deltaDepthExceeded(oid);
        chain.push(current);
        const next = baseOf(current);
        if (next === undefined) {
          object = current.baseOid === null ? undefined : seeds.get(current.baseOid);
          if (object !== undefined) break;
          throw new CorruptError(
            `missing delta base at pack ${current.packId} offset ${current.baseOffset} for ${current.oid}`,
          );
        }
        object = cachedObject(next);
        if (object !== undefined) break;
        current = next;
      }
      if (object === undefined) {
        throw new CorruptError(`packed object ${oid} did not resolve a base`);
      }
      for (let index = chain.length - 1; index >= 0; index--) {
        const entry = chain[index]!;
        checkDeltaInflateBudget(object.data, entry.entrySize);
        const delta = inflate(entry);
        const targetSize = validateDeltaWorkingSet(object.data, delta, entry.size);
        const target: RawObject = {
          type: object.type,
          data: applyDelta(object.data, delta),
        };
        if (targetSize !== target.data.length) {
          throw new CorruptError(`pack entry at ${entry.offset} has inconsistent size metadata`);
        }
        object = target;
        if (object.data.length !== entry.size || object.type !== entry.type) {
          throw new CorruptError(`pack entry at ${entry.offset} has inconsistent type or size`);
        }
        if (!bypassCache) this.data.cacheObject(entry.packId, entry.oid, object);
      }
      if (object.type !== first.type || object.data.length !== first.size) {
        throw new CorruptError(`packed object ${oid} has inconsistent type or size`);
      }
      result.set(oid, object);
    }
    return result;
  }
}
