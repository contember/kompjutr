// Pack-native object storage. A received packfile is written to SQLite
// verbatim, still compressed, in fixed-size chunk rows, and indexed
// (oid -> pack, offset, delta base). Reads pull only the chunks an object
// actually spans, so nothing ever inflates a whole repository.

import { concat, toHex } from "../core/bytes.js";
import { CorruptError } from "../core/errors.js";
import { ByteLru } from "../core/lru.js";
import { applyDelta } from "../core/pack/delta.js";
import {
  hashObject,
  NUMBER_TYPE,
  objectHeader,
  type ObjectType,
  type RawObject,
} from "../core/objects.js";
import { Sha1 } from "../core/sha1.js";
import { InflateStream, inflatePrefix } from "../core/zlib.js";
import { blob, readBlob, type SqlDatabase } from "./db.js";

/** Bytes per `git_pack_data` row. Comfortably under the DO row limit. */
export const PACK_CHUNK = 1024 * 1024;

/** Git's default pack depth is 50; 100 rejects a crafted chain without stack overflow. */
const MAX_DELTA_DEPTH = 100;

/** Recent (offset -> oid) pairs kept in memory for ofs-delta bases. */
const OFFSET_WINDOW = 100_000;

export interface PackCacheOptions {
  /** Bytes of still-compressed pack rows held hot. */
  chunkBytes?: number;
  /** Largest entry inflated into one buffer. Anything above streams. */
  maxBufferedEntry?: number;
  /** Largest object admitted to the shared object cache. */
  cacheEntryLimit?: number;
}

const DEFAULT_CHUNK_BYTES = 4 * PACK_CHUNK;
const DEFAULT_MAX_BUFFERED_ENTRY = 8 * 1024 * 1024;
const DEFAULT_CACHE_ENTRY_LIMIT = 2 * 1024 * 1024;

export interface PackedEntry {
  oid: string;
  packId: number;
  offset: number;
  dataOff: number;
  dataLen: number;
  type: ObjectType;
  size: number;
  entrySize: number;
  baseOid: string | null;
}

interface PackObjectRow {
  pack_id: number;
  offset: number;
  data_off: number;
  data_len: number;
  type: ObjectType;
  size: number;
  entry_size: number;
  base_oid: string | null;
}

export interface PackIngestOptions {
  /** Refuse a pack larger than this. */
  maxBytes?: number;
  onProgress?: (message: string) => void;
  /** Awaited periodically so the runtime can flush its write buffer. */
  yieldNow?: () => Promise<void>;
  now?: () => number;
}

export interface PackIngestResult {
  packId: number;
  count: number;
  bytes: number;
}

/** Resolves an oid the pack index does not hold (loose storage, thin-pack bases). */
export type ExternalResolver = (oid: string) => RawObject | null;

/**
 * The largest a valid deflate stream can be for `size` bytes of input:
 * stored blocks cost five bytes per 65535, plus the zlib header and
 * checksum. A sender that pads beyond this still works — the read window
 * grows and retries — but this bound gets the common case in one pass.
 */
function compressedBound(size: number): number {
  return size + 5 * Math.ceil((size + 1) / 65535) + 64;
}

export class PackStore {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #external: ExternalResolver;
  readonly #objects: ByteLru<string, RawObject>;
  readonly #chunks: ByteLru<string, Uint8Array>;
  readonly #maxBufferedEntry: number;
  readonly #cacheEntryLimit: number;

  constructor(
    db: SqlDatabase,
    repoId: number,
    objects: ByteLru<string, RawObject>,
    external: ExternalResolver,
    options: PackCacheOptions = {},
  ) {
    this.#db = db;
    this.#repoId = repoId;
    this.#external = external;
    this.#objects = objects;
    this.#chunks = new ByteLru(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, (c) => c.length);
    this.#maxBufferedEntry = options.maxBufferedEntry ?? DEFAULT_MAX_BUFFERED_ENTRY;
    this.#cacheEntryLimit = options.cacheEntryLimit ?? DEFAULT_CACHE_ENTRY_LIMIT;
  }

  /** Bytes the chunk cache currently holds. */
  get cachedChunkBytes(): number {
    return this.#chunks.bytes;
  }

  lookup(oid: string): PackedEntry | null {
    const row = this.#db.one<PackObjectRow>(
      "SELECT pack_id, offset, data_off, data_len, type, size, entry_size, base_oid FROM git_pack_objects WHERE repo_id = ? AND oid = ?",
      this.#repoId,
      oid,
    );
    if (row === undefined) return null;
    return {
      oid,
      packId: row.pack_id,
      offset: row.offset,
      dataOff: row.data_off,
      dataLen: row.data_len,
      type: row.type,
      size: row.size,
      entrySize: row.entry_size,
      baseOid: row.base_oid,
    };
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    const row = this.#db.one<{ type: ObjectType; size: number }>(
      "SELECT type, size FROM git_pack_objects WHERE repo_id = ? AND oid = ?",
      this.#repoId,
      oid,
    );
    return row ?? null;
  }

  count(): number {
    return (
      this.#db.scalar<number>(
        "SELECT COUNT(*) FROM git_pack_objects WHERE repo_id = ?",
        this.#repoId,
      ) ?? 0
    );
  }

  findPrefix(prefix: string, limit: number): string[] {
    return this.#db
      .all<{ oid: string }>(
        "SELECT oid FROM git_pack_objects WHERE repo_id = ? AND oid >= ? AND oid < ? LIMIT ?",
        this.#repoId,
        prefix,
        `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`,
        limit,
      )
      .map((row) => row.oid);
  }

  /** Every oid the pack index holds, in index order. */
  oids(): string[] {
    return this.#db
      .all<{ oid: string }>("SELECT oid FROM git_pack_objects WHERE repo_id = ?", this.#repoId)
      .map((row) => row.oid);
  }

  /**
   * Inflate and delta-resolve an object. The base chain is walked through
   * index lookups first — bounding its length and catching cycles before
   * anything is inflated — then applied upward from the base, holding at
   * most two inflated buffers at a time.
   */
  read(oid: string): RawObject | null {
    const cached = this.#objects.get(oid);
    if (cached !== undefined) return cached;

    const first = this.lookup(oid);
    if (first === null) return null;

    const chain: PackedEntry[] = [];
    const seen = new Set<string>();
    let base: RawObject | null = null;
    let current: PackedEntry = first;
    for (;;) {
      if (seen.has(current.oid)) throw new CorruptError(`cyclic delta chain at ${current.oid}`);
      seen.add(current.oid);
      if (current.baseOid === null) {
        base = { type: current.type, data: this.#inflateEntry(current) };
        break;
      }
      if (chain.length >= MAX_DELTA_DEPTH) {
        throw new CorruptError(`delta chain deeper than ${MAX_DELTA_DEPTH} at ${oid}`);
      }
      chain.push(current);
      const cachedBase = this.#objects.get(current.baseOid);
      if (cachedBase !== undefined) {
        base = cachedBase;
        break;
      }
      const next = this.lookup(current.baseOid);
      if (next === null) {
        const external = this.#external(current.baseOid);
        if (external === null) {
          throw new CorruptError(`missing delta base ${current.baseOid} for ${current.oid}`);
        }
        base = external;
        break;
      }
      current = next;
    }

    let object = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = chain[i]!;
      const delta = this.#inflateEntry(entry);
      object = { type: base.type, data: applyDelta(object.data, delta) };
      this.#cacheObject(entry.oid, object);
    }
    if (chain.length === 0) this.#cacheObject(oid, object);
    return object;
  }

  #cacheObject(oid: string, object: RawObject): void {
    if (object.data.length <= this.#cacheEntryLimit) this.#objects.set(oid, object);
  }

  /** Inflate one indexed entry, whose compressed length is already known. */
  #inflateEntry(entry: PackedEntry): Uint8Array {
    const result = inflatePrefix(this.readRaw(entry.packId, entry.dataOff, entry.dataLen));
    if (result === null) throw new CorruptError(`truncated pack entry at ${entry.offset}`);
    return result.data;
  }

  /** Still-compressed bytes of a pack region, assembled from chunk rows. */
  readRaw(packId: number, offset: number, length: number): Uint8Array {
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

  /**
   * One decoded `git_pack_data` row through the LRU. Rows are immutable
   * once written — a chunk is inserted exactly once and only ever removed
   * wholesale, at which point the cache is cleared — so a hit is never
   * stale.
   */
  #chunk(packId: number, seq: number): Uint8Array {
    const key = `${packId}:${seq}`;
    const hit = this.#chunks.get(key);
    if (hit !== undefined) return hit;
    const row = this.#db.one<{ data: unknown }>(
      "SELECT data FROM git_pack_data WHERE repo_id = ? AND pack_id = ? AND seq = ?",
      this.#repoId,
      packId,
      seq,
    );
    if (row === undefined) throw new CorruptError(`pack ${packId}: missing chunk ${seq}`);
    const chunk = readBlob(row.data);
    this.#chunks.set(key, chunk);
    return chunk;
  }

  clearCaches(): void {
    this.#chunks.clear();
  }

  /** Drop every pack left half-written by an interrupted ingest. */
  reclaimPending(): number {
    const pending = this.#db.all<{ pack_id: number }>(
      "SELECT pack_id FROM git_pack_meta WHERE repo_id = ? AND state != 'complete'",
      this.#repoId,
    );
    const orphaned = this.#db.all<{ pack_id: number }>(
      `SELECT DISTINCT d.pack_id AS pack_id FROM git_pack_data d
         LEFT JOIN git_pack_meta m ON m.repo_id = d.repo_id AND m.pack_id = d.pack_id
        WHERE d.repo_id = ? AND m.pack_id IS NULL`,
      this.#repoId,
    );
    const ids = new Set([...pending, ...orphaned].map((row) => row.pack_id));
    if (ids.size === 0) return 0;
    this.#db.transactionSync(() => {
      for (const packId of ids) this.#deletePack(packId);
    });
    this.#chunks.clear();
    return ids.size;
  }

  #deletePack(packId: number): void {
    for (const table of ["git_pack_data", "git_pack_objects", "git_pack_pending", "git_pack_meta"]) {
      this.#db.run(`DELETE FROM ${table} WHERE repo_id = ? AND pack_id = ?`, this.#repoId, packId);
    }
  }

  /**
   * Stream a packfile into storage: chunk rows first (verifying the SHA-1
   * trailer as the bytes go past), then a sequential index pass with eager
   * delta resolution, then a straggler pass for deltas whose base appeared
   * later. The pack is marked complete only once all three succeed, so an
   * interrupted fetch leaves nothing that later reads can see.
   */
  async ingest(
    source: AsyncIterable<Uint8Array>,
    options: PackIngestOptions = {},
  ): Promise<PackIngestResult> {
    this.reclaimPending();
    const packId =
      (this.#db.scalar<number | null>(
        "SELECT MAX(pack_id) FROM git_pack_meta WHERE repo_id = ?",
        this.#repoId,
      ) ?? 0) + 1;
    const now = options.now ?? Date.now;
    const say = options.onProgress ?? (() => {});
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const yieldNow = options.yieldNow ?? (() => Promise.resolve());

    this.#db.run(
      "INSERT INTO git_pack_meta (repo_id, pack_id, size, count, state, created) VALUES (?, ?, 0, 0, 'pending', ?)",
      this.#repoId,
      packId,
      now(),
    );

    const total = await this.#writeChunks(source, packId, maxBytes, say, yieldNow);
    const count = await this.#indexPack(packId, total, say, yieldNow);

    this.#db.transactionSync(() => {
      this.#db.run(
        "UPDATE git_pack_meta SET size = ?, count = ?, state = 'complete' WHERE repo_id = ? AND pack_id = ?",
        total,
        count,
        this.#repoId,
        packId,
      );
    });
    return { packId, count, bytes: total };
  }

  /**
   * Phase A: bytes to chunk rows. Strictly linear over a fixed buffer —
   * the source may hand over one huge chunk, so nothing re-concatenates
   * the remainder.
   */
  async #writeChunks(
    source: AsyncIterable<Uint8Array>,
    packId: number,
    maxBytes: number,
    say: (message: string) => void,
    yieldNow: () => Promise<void>,
  ): Promise<number> {
    const sha = new Sha1();
    let tail = new Uint8Array(0); // rolling 20-byte lookbehind: the trailer
    let total = 0;
    let seq = 0;
    let announced = 0;
    const buffer = new Uint8Array(PACK_CHUNK);
    let filled = 0;

    const feed = (data: Uint8Array): void => {
      total += data.length;
      if (total > maxBytes) throw new CorruptError("pack exceeds the maximum accepted size");
      // Everything except the final 20 bytes is covered by the checksum,
      // and which bytes those are is only known at the end.
      const joined = tail.length > 0 ? concat([tail, data]) : data;
      if (joined.length > 20) {
        sha.update(joined.subarray(0, joined.length - 20));
        tail = joined.slice(joined.length - 20);
      } else {
        tail = joined.slice();
      }
      let offset = 0;
      while (offset < data.length) {
        const take = Math.min(PACK_CHUNK - filled, data.length - offset);
        buffer.set(data.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === PACK_CHUNK) {
          this.#writeChunk(packId, seq++, buffer.slice());
          filled = 0;
        }
      }
      if (total - announced >= 16 * 1024 * 1024) {
        announced = total;
        say(`Receiving objects: ${Math.round(total / 1048576)} MiB\n`);
      }
    };

    const SLICE = 4 * 1024 * 1024;
    for await (const data of source) {
      if (data.length === 0) continue;
      for (let offset = 0; offset < data.length; offset += SLICE) {
        feed(data.subarray(offset, offset + SLICE));
        await yieldNow();
      }
    }
    if (filled > 0) this.#writeChunk(packId, seq++, buffer.slice(0, filled));

    if (total < 32) throw new CorruptError("pack is too small to be valid");
    if (toHex(tail) !== toHex(sha.digest())) throw new CorruptError("pack checksum mismatch");
    return total;
  }

  #writeChunk(packId: number, seq: number, data: Uint8Array): void {
    this.#db.run(
      "INSERT INTO git_pack_data (repo_id, pack_id, seq, data) VALUES (?, ?, ?, ?)",
      this.#repoId,
      packId,
      seq,
      blob(data),
    );
  }

  /** Phase B + C: index every entry, then drain the deferred deltas. */
  async #indexPack(
    packId: number,
    total: number,
    say: (message: string) => void,
    yieldNow: () => Promise<void>,
  ): Promise<number> {
    const reader = new PackReader(this, packId, total);
    const magic = reader.take(4);
    if (magic[0] !== 0x50 || magic[1] !== 0x41 || magic[2] !== 0x43 || magic[3] !== 0x4b) {
      throw new CorruptError("bad pack signature");
    }
    const version = reader.uint32();
    const count = reader.uint32();
    if (version !== 2 && version !== 3) throw new CorruptError(`unsupported pack version ${version}`);

    const offsets = new OffsetWindow();
    const offsetToOid = (offset: number): string | null => {
      const hit = offsets.get(offset);
      if (hit !== null) return hit;
      const row = this.#db.one<{ oid: string }>(
        "SELECT oid FROM git_pack_objects WHERE repo_id = ? AND pack_id = ? AND offset = ?",
        this.#repoId,
        packId,
        offset,
      );
      return row?.oid ?? null;
    };

    let deferred = 0;
    for (let i = 0; i < count; i++) {
      const header = reader.entryHeader();
      const entryType = header.kind === null ? NUMBER_TYPE[header.type]! : null;
      const entry = this.#inflateAt(reader, header.dataOff, header.entrySize, entryType);

      if (header.kind === null) {
        const type = entryType!;
        const oid = entry.data === null ? entry.streamedOid! : hashObject(type, entry.data);
        this.#insertObject([
          oid,
          packId,
          header.offset,
          header.dataOff,
          entry.consumed,
          type,
          header.entrySize,
          header.entrySize,
          null,
        ]);
        offsets.set(header.offset, oid);
        if (entry.data !== null) this.#cacheObject(oid, { type, data: entry.data });
      } else {
        const baseOid =
          header.kind === "ref" ? header.baseOid! : offsetToOid(header.offset - header.baseDelta!);
        let resolved = false;
        if (entry.data !== null && baseOid !== null) {
          const base = this.#objects.get(baseOid) ?? this.#readForBase(baseOid);
          if (base !== null) {
            const data = applyDelta(base.data, entry.data);
            const oid = hashObject(base.type, data);
            this.#insertObject([
              oid,
              packId,
              header.offset,
              header.dataOff,
              entry.consumed,
              base.type,
              data.length,
              header.entrySize,
              baseOid,
            ]);
            offsets.set(header.offset, oid);
            this.#cacheObject(oid, { type: base.type, data });
            resolved = true;
          }
        }
        if (!resolved) {
          this.#db.run(
            "INSERT OR REPLACE INTO git_pack_pending (repo_id, pack_id, offset, data_off, data_len, entry_size, base_oid, base_offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            this.#repoId,
            packId,
            header.offset,
            header.dataOff,
            entry.consumed,
            header.entrySize,
            header.kind === "ref" ? header.baseOid : null,
            header.kind === "ofs" ? header.offset - header.baseDelta! : null,
          );
          deferred++;
        }
      }

      if ((i & 1023) === 1023) {
        await yieldNow();
        if ((i & 65535) === 65535) say(`Resolving deltas: ${i + 1}/${count}\n`);
      }
    }

    if (reader.position !== total - 20) {
      throw new CorruptError("pack has trailing data or a bad object count");
    }
    await this.#drainPending(packId, offsets, offsetToOid, yieldNow);
    if (deferred > 0) say(`Resolved ${deferred} deferred delta(s)\n`);
    return count;
  }

  /** A base that lives in an already-indexed pack, loose storage, or another pack. */
  #readForBase(oid: string): RawObject | null {
    try {
      const packed = this.read(oid);
      if (packed !== null) return packed;
    } catch {
      // A base that itself fails to resolve is treated as absent; the
      // straggler pass retries once more of the pack is indexed.
    }
    return this.#external(oid);
  }

  async #drainPending(
    packId: number,
    offsets: OffsetWindow,
    offsetToOid: (offset: number) => string | null,
    yieldNow: () => Promise<void>,
  ): Promise<void> {
    let remaining =
      this.#db.scalar<number>(
        "SELECT COUNT(*) FROM git_pack_pending WHERE repo_id = ? AND pack_id = ?",
        this.#repoId,
        packId,
      ) ?? 0;
    while (remaining > 0) {
      let progressed = 0;
      let after = -1;
      for (;;) {
        const page = this.#db.all<{
          offset: number;
          data_off: number;
          data_len: number;
          entry_size: number;
          base_oid: string | null;
          base_offset: number | null;
        }>(
          "SELECT offset, data_off, data_len, entry_size, base_oid, base_offset FROM git_pack_pending WHERE repo_id = ? AND pack_id = ? AND offset > ? ORDER BY offset LIMIT 256",
          this.#repoId,
          packId,
          after,
        );
        if (page.length === 0) break;
        for (const row of page) {
          after = row.offset;
          const baseOid =
            row.base_oid ?? (row.base_offset === null ? null : offsetToOid(row.base_offset));
          if (baseOid === null) continue;
          const base = this.#objects.get(baseOid) ?? this.#readForBase(baseOid);
          if (base === null) continue;
          const result = inflatePrefix(this.readRaw(packId, row.data_off, row.data_len));
          if (result === null) throw new CorruptError(`truncated delta at ${row.offset}`);
          const data = applyDelta(base.data, result.data);
          const oid = hashObject(base.type, data);
          this.#insertObject([
            oid,
            packId,
            row.offset,
            row.data_off,
            row.data_len,
            base.type,
            data.length,
            row.entry_size,
            baseOid,
          ]);
          this.#db.run(
            "DELETE FROM git_pack_pending WHERE repo_id = ? AND pack_id = ? AND offset = ?",
            this.#repoId,
            packId,
            row.offset,
          );
          offsets.set(row.offset, oid);
          this.#cacheObject(oid, { type: base.type, data });
          progressed++;
        }
        await yieldNow();
      }
      remaining -= progressed;
      if (progressed === 0 && remaining > 0) {
        throw new CorruptError(`cannot resolve ${remaining} delta object(s): missing base`);
      }
    }
  }

  #insertObject(row: (string | number | null)[]): void {
    // OR IGNORE, never OR REPLACE: a duplicate object keeps its first
    // location. Re-pointing it at the incoming pack would make it
    // unresolvable if this ingest is later reclaimed.
    this.#db.run(
      "INSERT OR IGNORE INTO git_pack_objects (repo_id, oid, pack_id, offset, data_off, data_len, type, size, entry_size, base_oid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      this.#repoId,
      ...row,
    );
  }

  /**
   * Inflate the entry whose compressed bytes start at `dataOff`. Small
   * entries come back whole; anything past the buffer limit is streamed,
   * hashed on the way past, and reported by oid only.
   */
  #inflateAt(
    reader: PackReader,
    dataOff: number,
    entrySize: number,
    type: ObjectType | null,
  ): { data: Uint8Array | null; consumed: number; streamedOid: string | null } {
    if (entrySize <= this.#maxBufferedEntry) {
      let width = Math.min(compressedBound(entrySize), reader.limit - dataOff);
      for (;;) {
        const result = inflatePrefix(this.readRaw(reader.packId, dataOff, width));
        if (result !== null) {
          if (result.data.length !== entrySize) {
            throw new CorruptError(`pack entry size mismatch at ${dataOff}`);
          }
          reader.seek(dataOff + result.consumed);
          return { data: result.data, consumed: result.consumed, streamedOid: null };
        }
        if (dataOff + width >= reader.limit) {
          throw new CorruptError(`truncated pack entry at ${dataOff}`);
        }
        width = Math.min(width * 2, reader.limit - dataOff);
      }
    }

    // Oversized: never hold the object. A full entry still yields its oid
    // because the hash is fed as the bytes go past; an oversized delta is
    // deferred and buffered once, at resolution time.
    const sha = type === null ? null : new Sha1().update(objectHeader(type, entrySize));
    const stream = new InflateStream((chunk) => {
      sha?.update(chunk);
    });
    reader.seek(dataOff);
    let consumed = 0;
    while (!stream.ended) {
      const window = reader.window();
      if (window.length === 0) throw new CorruptError(`truncated pack entry at ${dataOff}`);
      const used = stream.push(window);
      consumed += used;
      reader.seek(reader.position + (stream.ended ? used : window.length));
    }
    if (stream.inflated !== entrySize) {
      throw new CorruptError(`pack entry size mismatch at ${dataOff}`);
    }
    return { data: null, consumed, streamedOid: sha === null ? null : toHex(sha.digest()) };
  }
}

/** Rotating (offset -> oid) map: ofs-delta bases are almost always recent. */
class OffsetWindow {
  #current = new Map<number, string>();
  #previous = new Map<number, string>();

  set(offset: number, oid: string): void {
    this.#current.set(offset, oid);
    if (this.#current.size >= OFFSET_WINDOW) {
      this.#previous = this.#current;
      this.#current = new Map();
    }
  }

  get(offset: number): string | null {
    return this.#current.get(offset) ?? this.#previous.get(offset) ?? null;
  }
}

interface EntryHeader {
  offset: number;
  dataOff: number;
  type: number;
  entrySize: number;
  kind: "ofs" | "ref" | null;
  baseDelta: number | null;
  baseOid: string | null;
}

/** Sequential cursor over a pack stored as chunk rows. */
class PackReader {
  #position = 0;

  constructor(
    private readonly store: PackStore,
    readonly packId: number,
    readonly limit: number,
  ) {}

  get position(): number {
    return this.#position;
  }

  seek(position: number): void {
    this.#position = position;
  }

  byte(): number {
    if (this.#position >= this.limit) throw new CorruptError("pack truncated");
    const value = this.store.readRaw(this.packId, this.#position, 1)[0]!;
    this.#position += 1;
    return value;
  }

  take(length: number): Uint8Array {
    const bytes = this.store.readRaw(this.packId, this.#position, length);
    this.#position += length;
    return bytes;
  }

  uint32(): number {
    const bytes = this.take(4);
    return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  }

  /** Remaining bytes of the chunk row containing the cursor. */
  window(): Uint8Array {
    if (this.#position >= this.limit) return new Uint8Array(0);
    const chunkStart = Math.floor(this.#position / PACK_CHUNK) * PACK_CHUNK;
    const end = Math.min(chunkStart + PACK_CHUNK, this.limit);
    return this.store.readRaw(this.packId, this.#position, end - this.#position);
  }

  entryHeader(): EntryHeader {
    const offset = this.#position;
    let byte = this.byte();
    const type = (byte >> 4) & 7;
    let entrySize = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = this.byte();
      entrySize += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let kind: "ofs" | "ref" | null = null;
    let baseDelta: number | null = null;
    let baseOid: string | null = null;
    if (type === 6) {
      kind = "ofs";
      byte = this.byte();
      let delta = byte & 0x7f;
      while (byte & 0x80) {
        byte = this.byte();
        delta = (delta + 1) * 128 + (byte & 0x7f);
      }
      baseDelta = delta;
    } else if (type === 7) {
      kind = "ref";
      baseOid = toHex(this.take(20));
    } else if (NUMBER_TYPE[type] === undefined) {
      throw new CorruptError(`bad object type ${type} at ${offset}`);
    }
    return { offset, dataOff: this.#position, type, entrySize, kind, baseDelta, baseOid };
  }
}
