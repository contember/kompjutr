// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { readBlob, type SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, hasErrorCode } from "../../../common/errors.js";
import type { ByteLru } from "../../../common/lru.js";
import type { RawObject } from "../../../common/objects.js";
import { InflateInto, PrefixInflater } from "../../../common/zlib.js";
import { PACK_PENDING_PAGE_ROWS } from "../pack-ingest-index.js";
import {
  MAX_PACK_DELTA_WORKING_BYTES,
  PACK_CHUNK,
  PACK_RANGE_BATCH_BYTES,
  PACK_READ_BYTES,
  type PackedEntry,
  type PackRangeRequest,
  type PackSharedState,
  pushExactInflate,
  requirePackId,
} from "../shared.js";
import { loadPackChunks, type PackChunkCoordinate } from "./read-chunks.js";

/** One requested range and the bytes scattered into it so far. */
interface RangeTarget {
  request: PackRangeRequest;
  output: Uint8Array;
  filled: number;
}

export class PackDataReader {
  // workerd retains native info-mode decoder state until major GC, so reuse one bounded decoder.
  readonly #prefix = new PrefixInflater();

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly objects: ByteLru<string, RawObject>,
    private readonly chunks: ByteLru<string, Uint8Array>,
    private readonly cacheNamespace: string,
    private readonly sharedState: PackSharedState,
    private readonly cacheEntryLimit: number,
  ) {}

  get cachedChunkBytes(): number {
    return this.chunks.bytes;
  }
  inflateCompressed(
    entry: PackedEntry,
    compressed: Uint8Array | undefined,
    streamed: boolean,
    bypassCache: boolean,
  ): Uint8Array {
    if (compressed === undefined) {
      if (!streamed) throw new CorruptError(`packed blob entry ${entry.oid} was not loaded`);
      return this.#inflateStoredEntry(
        entry.packId,
        entry.dataOff,
        entry.dataLen,
        entry.entrySize,
        `pack entry at ${entry.offset}`,
        bypassCache,
      );
    }
    return this.#inflateBytes(compressed, entry.entrySize, `pack entry at ${entry.offset}`);
  }

  #inflateBytes(input: Uint8Array, expectedSize: number, label: string): Uint8Array {
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > MAX_PACK_DELTA_WORKING_BYTES
    ) {
      throw new CorruptError(`${label} exceeds the bounded inflate limit`);
    }
    let result: ReturnType<PrefixInflater["inflate"]>;
    try {
      result = this.#prefix.inflate(input, expectedSize);
    } catch (error) {
      if (hasErrorCode(error, "EINFLATESIZE")) {
        throw new CorruptError(`${label} exceeds its indexed size`, { cause: error });
      }
      throw new CorruptError(`${label} is not a valid zlib stream`, { cause: error });
    }
    if (result !== null && result.data.length > expectedSize) {
      throw new CorruptError(`${label} exceeds its indexed size`);
    }
    if (
      result === null ||
      result.data.length !== expectedSize ||
      result.consumed !== input.length
    ) {
      throw new CorruptError(`${label} size does not match its index metadata`);
    }
    return result.data;
  }

  cacheObject(packId: number, oid: string, object: RawObject): void {
    if (object.data.length <= this.cacheEntryLimit) {
      this.objects.set(this.objectCacheKey(packId, oid), object);
    }
  }

  objectCacheKey(packId: number, oid: string): string {
    return `${this.cacheNamespace}:${this.sharedState.cacheGeneration}:pack:${packId}:${oid}`;
  }

  getCachedChunk(packId: number, seq: number): Uint8Array | undefined {
    return this.chunks.get(this.#chunkCacheKey(packId, seq));
  }

  cacheChunk(packId: number, seq: number, chunk: Uint8Array): void {
    this.chunks.set(this.#chunkCacheKey(packId, seq), chunk);
  }

  #chunkCacheKey(packId: number, seq: number): string {
    return `${this.cacheNamespace}:${this.sharedState.cacheGeneration}:row:${packId}:${seq}`;
  }

  #inflateStoredEntry(
    packId: number,
    dataOff: number,
    dataLen: number,
    expectedSize: number,
    label: string,
    bypassCache = false,
  ): Uint8Array {
    if (
      !Number.isSafeInteger(dataLen) ||
      !Number.isSafeInteger(expectedSize) ||
      dataLen < 0 ||
      expectedSize < 0 ||
      expectedSize > MAX_PACK_DELTA_WORKING_BYTES
    ) {
      throw new CorruptError(`${label} exceeds the bounded inflate limit`);
    }
    const stream = new InflateInto(expectedSize);
    let consumed = 0;
    while (!stream.ended && consumed < dataLen) {
      const length = Math.min(PACK_READ_BYTES, dataLen - consumed);
      const input = bypassCache
        ? this.readRawUncached(packId, dataOff + consumed, length)
        : this.readRaw(packId, dataOff + consumed, length);
      const used = pushExactInflate(stream, input, label);
      consumed += used;
      if (!stream.ended && used !== input.length) {
        throw new CorruptError(`${label} inflater stopped before the stream ended`);
      }
    }
    if (!stream.ended || consumed !== dataLen) {
      throw new CorruptError(`${label} size does not match its index metadata`);
    }
    try {
      return stream.finish();
    } catch (error) {
      throw new CorruptError(`${label} size does not match its index metadata`, { cause: error });
    }
  }

  readRangeBatch(packId: number, requests: readonly PackRangeRequest[]): Map<number, Uint8Array> {
    if (requests.length === 0 || requests.length > PACK_PENDING_PAGE_ROWS) {
      throw new CorruptError("pack range batch has an invalid request count");
    }
    let totalBytes = 0;
    for (const request of requests) {
      totalBytes += request.length;
      if (
        !Number.isSafeInteger(request.offset) ||
        !Number.isSafeInteger(request.position) ||
        !Number.isSafeInteger(request.length) ||
        request.offset < 0 ||
        request.position < 0 ||
        request.length < 1 ||
        !Number.isSafeInteger(request.position + request.length) ||
        totalBytes > PACK_RANGE_BATCH_BYTES
      ) {
        throw new CorruptError("pack range batch has invalid coordinates");
      }
    }

    const outputs = new Map<number, Uint8Array>();
    const targets: RangeTarget[] = [];
    const consumers = new Map<number, RangeTarget[]>();
    for (const request of requests) {
      if (outputs.has(request.offset)) {
        throw new CorruptError("pack range batch has a duplicate object offset");
      }
      const target = { request, output: new Uint8Array(request.length), filled: 0 };
      outputs.set(request.offset, target.output);
      targets.push(target);
      const first = Math.floor(request.position / PACK_CHUNK);
      const last = Math.floor((request.position + request.length - 1) / PACK_CHUNK);
      for (let seq = first; seq <= last; seq++) {
        const list = consumers.get(seq);
        if (list === undefined) consumers.set(seq, [target]);
        else list.push(target);
      }
    }

    const scatter = (seq: number, chunk: Uint8Array): void => {
      const chunkStart = seq * PACK_CHUNK;
      for (const target of consumers.get(seq) ?? []) {
        const { position, length } = target.request;
        const from = Math.max(position, chunkStart);
        const to = Math.min(position + length, chunkStart + PACK_CHUNK);
        if (to - chunkStart > chunk.length) {
          throw new CorruptError(`pack ${packId}: chunk ${seq} is truncated`);
        }
        target.output.set(chunk.subarray(from - chunkStart, to - chunkStart), from - position);
        target.filled += to - from;
      }
    };
    const missing: PackChunkCoordinate[] = [];
    for (const seq of consumers.keys()) {
      const hit = this.getCachedChunk(packId, seq);
      if (hit === undefined) missing.push({ packId, seq });
      else scatter(seq, hit);
    }
    loadPackChunks(this.db, this.repoId, missing, (_, seq, chunk) => {
      scatter(seq, chunk);
      this.cacheChunk(packId, seq, chunk);
    });
    for (const target of targets) {
      if (target.filled !== target.request.length) {
        throw new CorruptError(`pack ${packId}: missing range bytes`);
      }
    }
    return outputs;
  }

  /** Still-compressed bytes of a pack region, assembled from chunk rows. */
  readRaw(packId: number, offset: number, length: number): Uint8Array {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > PACK_READ_BYTES ||
      !Number.isSafeInteger(offset + length)
    ) {
      throw new CorruptError("pack read exceeds the bounded region limit");
    }
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / PACK_CHUNK);
    const last = Math.floor((offset + length - 1) / PACK_CHUNK);
    if (first === last) {
      const chunk = this.#chunk(packId, first);
      const start = offset - first * PACK_CHUNK;
      return chunk.subarray(start, start + length);
    }
    const out = new Uint8Array(length);
    for (let seq = first; seq <= last; seq++) {
      const chunk = this.#chunk(packId, seq);
      const chunkStart = seq * PACK_CHUNK;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(offset + length, chunkStart + chunk.length);
      if (to > from) out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - offset);
    }
    return out;
  }

  readRawUncached(packId: number, offset: number, length: number): Uint8Array {
    requirePackId(packId);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > PACK_READ_BYTES ||
      !Number.isSafeInteger(offset + length)
    ) {
      throw new CorruptError("uncached pack read exceeds the bounded region limit");
    }
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / PACK_CHUNK);
    const last = Math.floor((offset + length - 1) / PACK_CHUNK);
    const out = new Uint8Array(length);
    for (let seq = first; seq <= last; seq++) {
      const row = this.db.one<Record<string, unknown>>(
        "SELECT pack_id, seq, data FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = ?",
        this.repoId,
        packId,
        seq,
      );
      if (row === undefined || row.pack_id !== packId || row.seq !== seq) {
        throw new CorruptError(`pack ${packId}: missing chunk ${seq}`);
      }
      const chunk = readBlob(row.data);
      if (chunk.length < 1 || chunk.length > PACK_CHUNK) {
        throw new CorruptError(`pack ${packId}: chunk ${seq} has an invalid size`);
      }
      const chunkStart = seq * PACK_CHUNK;
      const from = Math.max(offset, chunkStart);
      const to = Math.min(offset + length, chunkStart + PACK_CHUNK);
      if (to - chunkStart > chunk.length) {
        throw new CorruptError(`pack ${packId}: chunk ${seq} is truncated`);
      }
      out.set(chunk.subarray(from - chunkStart, to - chunkStart), from - offset);
    }
    return out;
  }

  /**
   * One decoded `git_pack_data` row through the database-wide LRU. The key
   * includes both store and invalidation generations, so deleted rows can
   * stay stale only until this bounded cache evicts them.
   */
  #chunk(packId: number, seq: number): Uint8Array {
    const key = this.#chunkCacheKey(packId, seq);
    const hit = this.chunks.get(key);
    if (hit !== undefined) return hit;
    const row = this.db.one<{ data: unknown }>(
      "SELECT data FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = ?",
      this.repoId,
      packId,
      seq,
    );
    if (row === undefined) throw new CorruptError(`pack ${packId}: missing chunk ${seq}`);
    const chunk = readBlob(row.data);
    this.chunks.set(key, chunk);
    return chunk;
  }

  clearCaches(): void {
    this.sharedState.cacheGeneration++;
  }
}
