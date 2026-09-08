// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import { readBlob, type SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../../common/errors.js";
import type { ByteLru } from "../../../common/lru.js";
import type { RawObject } from "../../../common/objects.js";
import { InflateInto } from "../../../common/zlib.js";
import { PACK_PENDING_PAGE_ROWS } from "../pack-ingest-index.js";
import {
  MAX_PACK_DELTA_WORKING_BYTES,
  PACK_CHUNK,
  PACK_RANGE_BATCH_BYTES,
  PACK_RANGE_SLICE_BYTES,
  PACK_READ_BYTES,
  type PackedEntry,
  type PackRangeRequest,
  type PackSharedState,
  packRangeFragment,
  packRangeFragmentMask,
  pushExactInflate,
  requirePackId,
} from "../shared.js";

export class PackDataReader {
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
    const stream = new InflateInto(expectedSize);
    let consumed = 0;
    try {
      while (!stream.ended && consumed < input.length) {
        const used = pushExactInflate(stream, input.subarray(consumed), label);
        consumed += used;
        if (!stream.ended && used === 0) {
          throw new CorruptError(`${label} inflater made no progress`);
        }
      }
    } catch (error) {
      if (error instanceof CorruptError) throw error;
      throw new CorruptError(`${label} is not a valid zlib stream`, { cause: error });
    }
    if (!stream.ended || consumed !== input.length) {
      throw new CorruptError(`${label} size does not match its index metadata`);
    }
    try {
      return stream.finish();
    } catch (error) {
      throw new CorruptError(`${label} size does not match its index metadata`, { cause: error });
    }
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
        !Number.isSafeInteger(request.ordinal) ||
        !Number.isSafeInteger(request.offset) ||
        !Number.isSafeInteger(request.position) ||
        !Number.isSafeInteger(request.length) ||
        request.ordinal < 0 ||
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
    const seen = new Map<number, number>();
    for (const request of requests) {
      if (outputs.has(request.offset)) {
        throw new CorruptError("pack range batch has a duplicate object offset");
      }
      outputs.set(request.offset, new Uint8Array(request.length));
      seen.set(request.offset, 0);
    }
    for (const range of this.db.iterate(
      `WITH RECURSIVE /* pack-range substr <= ${PACK_RANGE_SLICE_BYTES} */
         requested(ordinal, object_offset, position, remaining) AS (
           SELECT json_extract(value, '$.ordinal'), json_extract(value, '$.offset'),
                  json_extract(value, '$.position'), json_extract(value, '$.length')
             FROM json_each(?)
         ),
         slices(ordinal, object_offset, position, remaining) AS (
           SELECT ordinal, object_offset, position, remaining FROM requested
           UNION ALL
           SELECT ordinal, object_offset,
                  position + min(remaining, ${PACK_RANGE_SLICE_BYTES},
                                 ${PACK_CHUNK} - position % ${PACK_CHUNK}),
                  remaining - min(remaining, ${PACK_RANGE_SLICE_BYTES},
                                  ${PACK_CHUNK} - position % ${PACK_CHUNK})
             FROM slices WHERE remaining > 0
         )
       SELECT slices.ordinal, slices.object_offset AS offset, slices.position,
              min(slices.remaining, ${PACK_RANGE_SLICE_BYTES},
                  ${PACK_CHUNK} - slices.position % ${PACK_CHUNK}) AS expected,
              substr(data.data, slices.position % ${PACK_CHUNK} + 1,
                     min(slices.remaining, ${PACK_RANGE_SLICE_BYTES},
                         ${PACK_CHUNK} - slices.position % ${PACK_CHUNK})) AS data
         FROM slices
        JOIN git_pack_data data
           ON data.repo_id = ? AND data.pack_id = ?
          AND data.seq = CAST(slices.position / ${PACK_CHUNK} AS INTEGER)
        WHERE slices.remaining > 0`,
      JSON.stringify(requests),
      this.repoId,
      packId,
    )) {
      if (
        typeof range.ordinal !== "number" ||
        typeof range.offset !== "number" ||
        typeof range.position !== "number" ||
        typeof range.expected !== "number" ||
        !Number.isSafeInteger(range.ordinal) ||
        !Number.isSafeInteger(range.offset) ||
        !Number.isSafeInteger(range.position) ||
        !Number.isSafeInteger(range.expected) ||
        range.ordinal < 0 ||
        range.ordinal >= requests.length ||
        range.expected < 1 ||
        range.expected > PACK_RANGE_SLICE_BYTES
      ) {
        throw new CorruptError("pack range batch returned invalid coordinates");
      }
      const request = requests[range.ordinal];
      const output = outputs.get(range.offset);
      const seenMask = seen.get(range.offset);
      const fragment =
        request === undefined || typeof range.position !== "number"
          ? -1
          : packRangeFragment(request, range.position, range.expected);
      if (
        request === undefined ||
        output === undefined ||
        seenMask === undefined ||
        request.offset !== range.offset ||
        fragment < 0 ||
        (seenMask & (2 ** fragment)) !== 0
      ) {
        throw new CorruptError("pack range batch returned an unexpected slice");
      }
      const data = readBlob(range.data);
      if (data.length !== range.expected) {
        throw new CorruptError("pack range batch returned a truncated slice");
      }
      output.set(data, range.position - request.position);
      seen.set(range.offset, seenMask | (2 ** fragment));
    }
    for (const request of requests) {
      if (seen.get(request.offset) !== packRangeFragmentMask(request)) {
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
