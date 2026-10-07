import { blob, type SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../common/bytes.js";
import { CorruptError, hasErrorCode } from "../../common/errors.js";
import type { ParsedTreeEntry, TreeParseResult } from "../../common/objects.js";
import { expectSafeInteger } from "../../common/rows.js";
import type { TreeSource } from "./tree-index.js";
import {
  TREE_INDEX_ROWS,
  TreeIndexBuffers,
  type TreeIndexRows,
  type TreeIndexWindow,
} from "./tree-index-rows.js";
import { seedTreeSourceSlots, TreeSourceSlot } from "./tree-source-slots.js";

/** SQLite queue record, four integer fields, and bounded error fields. */
export const TREE_QUEUE_ROW_FIXED_BYTES = 64 + 4 * 8 + 96;

/** Names a batch-owned buffer holds; a longer name takes the single-row path. */
const TREE_INDEX_NAME_BYTES = 128 * 1024;
const TREE_MODE = /^(?:0?40000|100644|100755|120000|160000)$/;

// Each window resolves its sources once, in the CTE. The `complete = 0` join
// skips a projection completed earlier and keeps a missing source from reaching
// the deferred FK check at COMMIT.
const ENTRY_WINDOW_SQL = `WITH source(position, source_key) AS MATERIALIZED (
     SELECT j.key, s.source_key
       FROM json_each(?) j
       JOIN git_tree_sources s
         ON s.repo_id = json_extract(j.value, '$[0]')
        AND s.tree_oid = json_extract(j.value, '$[1]')
        AND s.complete = 0
   )
   INSERT INTO git_tree_entries
     (source_key, ordinal, mode, name_bytes, oid, cumulative_base)
   SELECT source.source_key, json_extract(e.value, '$[1]'), json_extract(e.value, '$[2]'),
          substr(?, json_extract(e.value, '$[4]'), json_extract(e.value, '$[5]')),
          json_extract(e.value, '$[3]'), json_extract(e.value, '$[6]')
     FROM json_each(CAST(substr(?, ?, ?) AS TEXT)) e
    CROSS JOIN source ON source.position = json_extract(e.value, '$[0]')`;

const MARKER_WINDOW_SQL = `INSERT INTO git_tree_sources
     (repo_id, tree_oid, complete, object_size, entry_count, base_cost)
   SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
          1, json_extract(value, '$[2]'), json_extract(value, '$[3]'),
          json_extract(value, '$[4]')
     FROM json_each(CAST(substr(?, 1, ?) AS TEXT))
    WHERE true
   ON CONFLICT(repo_id, tree_oid) DO UPDATE SET
     complete = 1, object_size = excluded.object_size,
     entry_count = excluded.entry_count, base_cost = excluded.base_cost
    WHERE git_tree_sources.complete = 0`;

// The join proves every loose source was seeded by its object insert.
const SEEDED_MARKER_WINDOW_SQL = `INSERT INTO git_tree_sources
     (repo_id, tree_oid, complete, object_size, entry_count, base_cost)
   SELECT existing.repo_id, existing.tree_oid,
          1, json_extract(marker.value, '$[2]'), json_extract(marker.value, '$[3]'),
          json_extract(marker.value, '$[4]')
     FROM json_each(CAST(substr(?, 1, ?) AS TEXT)) marker
     JOIN git_tree_sources existing
       ON existing.repo_id = json_extract(marker.value, '$[0]')
      AND existing.tree_oid = json_extract(marker.value, '$[1]')
    WHERE true
   ON CONFLICT(repo_id, tree_oid) DO UPDATE SET
     complete = 1, object_size = excluded.object_size,
     entry_count = excluded.entry_count, base_cost = excluded.base_cost
   RETURNING source_key`;

function validateParsedTreeEntry(parsed: ParsedTreeEntry): void {
  const { entry, nameBytes } = parsed;
  if (!TREE_MODE.test(entry.mode)) throw new CorruptError(`invalid tree mode ${entry.mode}`);
  if (entry.name === "" || entry.name.includes("/") || nameBytes.includes(0)) {
    throw new CorruptError("invalid tree entry name");
  }
  if (!isOid(entry.oid)) throw new CorruptError("invalid tree entry oid");
}

function validateTreeSource(source: TreeSource): void {
  expectSafeInteger(source.repoId, 0, Number.MAX_SAFE_INTEGER, "tree source repository id");
  expectSafeInteger(source.objectSize, 0, Number.MAX_SAFE_INTEGER, "tree source object size");
  if (!isOid(source.treeOid)) throw new CorruptError("tree source has invalid metadata");
}

export interface TreeIndexBatchOptions {
  /** The loose object trigger seeded every source; a missing one is corrupt. */
  seeded: boolean;
  /**
   * Flush whenever the buffers fill. A deferred batch never flushes on its
   * own: its owner admits only sources that fit and flushes in a transaction.
   */
  autoFlush: boolean;
  /** Buffers borrowed from their owner; without them the batch owns its own. */
  buffers?: TreeIndexBuffers;
}

/** Parsed rows awaiting one flush; each statement resolves a tree's identity once. */
export class TreeIndexBatch {
  readonly #seeded: boolean;
  readonly #autoFlush: boolean;
  readonly #owned: boolean;
  #buffers: TreeIndexBuffers | null;
  readonly #pending: TreeSourceSlot[] = [];
  readonly #unseeded: TreeSourceSlot[] = [];
  readonly #window: TreeIndexWindow = {
    rows: 0,
    firstSource: 0,
    lastSource: 0,
    jsonOffset: 0,
    jsonLength: 0,
  };

  constructor(
    private readonly db: SqlDatabase,
    options: TreeIndexBatchOptions,
  ) {
    this.#seeded = options.seeded;
    this.#autoFlush = options.autoFlush;
    this.#owned = options.buffers === undefined;
    const buffers = options.buffers ?? new TreeIndexBuffers(TREE_INDEX_ROWS, TREE_INDEX_NAME_BYTES);
    buffers.borrow();
    this.#buffers = buffers;
  }

  get retainedRows(): number {
    return this.#rows().rows;
  }

  /** Whether a deferred batch can admit a source of `objectBytes` raw bytes. */
  holds(objectBytes: number): boolean {
    return this.#rows().holds(objectBytes);
  }

  open(source: TreeSource): TreeSourceSlot {
    validateTreeSource(source);
    return new TreeSourceSlot(source, this.#seeded);
  }

  addEntry(slot: TreeSourceSlot, parsed: ParsedTreeEntry, cumulativeBase: number): boolean {
    const rows = this.#rows();
    if (!rows.canAppend(parsed.nameBytes.length)) {
      this.#flushFull();
      if (!rows.canAppend(parsed.nameBytes.length)) {
        return this.#insertOversizedEntry(slot, parsed, cumulativeBase);
      }
    }
    if (!slot.seeded && slot.pending < 0) this.#unseeded.push(slot);
    rows.appendEntry(this.#pendingIndex(slot), parsed, cumulativeBase);
    return true;
  }

  addMarker(slot: TreeSourceSlot, count: number, baseCost: number): void {
    const rows = this.#rows();
    if (!rows.canMark()) this.#flushFull();
    rows.appendMarker(this.#pendingIndex(slot), count, baseCost);
  }

  /** Seed sources that have entries, then write entries before markers. */
  flush(): void {
    const buffers = this.#live();
    const rows = buffers.rows;
    if (rows.rows === 0) return;
    try {
      seedTreeSourceSlots(this.db, this.#unseeded);
      for (let row = 0; row < rows.entries; ) {
        row = rows.fillEntryWindow(row, buffers.entryWindow, this.#window);
        const bytes = blob(buffers.entryWindow);
        this.db.run(
          ENTRY_WINDOW_SQL,
          this.#sourcesJson(this.#window.firstSource, this.#window.lastSource),
          bytes,
          bytes,
          this.#window.jsonOffset,
          this.#window.jsonLength,
        );
      }
      if (rows.markers !== 0) this.#writeMarkers(rows, buffers.markerWindow);
    } catch (error) {
      this.dispose();
      throw error;
    }
    rows.reset();
    this.#clearPending();
  }

  dispose(): void {
    const buffers = this.#buffers;
    if (buffers === null) return;
    this.#buffers = null;
    this.#clearPending();
    if (!this.#owned) buffers.release();
  }

  #writeMarkers(rows: TreeIndexRows, bytes: Uint8Array): void {
    const jsonLength = rows.fillMarkerWindow(
      this.#pending.map((slot) => slot.source),
      bytes,
    );
    if (!this.#seeded) {
      this.db.run(MARKER_WINDOW_SQL, blob(bytes), jsonLength);
      return;
    }
    let returnedRows = 0;
    for (const _row of this.db.iterate(SEEDED_MARKER_WINDOW_SQL, blob(bytes), jsonLength)) {
      returnedRows++;
    }
    if (returnedRows !== rows.markers) throw new CorruptError("tree index source was not seeded");
  }

  #sourcesJson(first: number, last: number): string {
    return JSON.stringify(
      this.#pending.slice(first, last + 1).map(({ source }) => [source.repoId, source.treeOid]),
    );
  }

  #clearPending(): void {
    for (const slot of this.#pending) slot.pending = -1;
    this.#pending.length = 0;
    this.#unseeded.length = 0;
  }

  #flushFull(): void {
    if (!this.#autoFlush) throw new Error("deferred tree index batch admitted more than it holds");
    this.flush();
  }

  #pendingIndex(slot: TreeSourceSlot): number {
    if (slot.pending < 0) {
      slot.pending = this.#pending.length;
      this.#pending.push(slot);
    }
    return slot.pending;
  }

  #insertOversizedEntry(
    slot: TreeSourceSlot,
    parsed: ParsedTreeEntry,
    cumulativeBase: number,
  ): boolean {
    if (!slot.seeded) seedTreeSourceSlots(this.db, [slot]);
    const { repoId, treeOid } = slot.source;
    try {
      this.db.run(
        `INSERT INTO git_tree_entries
             (source_key, ordinal, mode, name_bytes, oid, cumulative_base)
           SELECT source.source_key, ?, ?, ?, ?, ?
             FROM git_tree_sources source
            WHERE source.repo_id = ? AND source.tree_oid = ? AND source.complete = 0`,
        parsed.ordinal,
        parsed.entry.mode,
        blob(parsed.nameBytes),
        parsed.entry.oid,
        cumulativeBase,
        repoId,
        treeOid,
      );
      return true;
    } catch (error) {
      if (!hasErrorCode(error, "E2BIG")) throw error;
      this.db.run(
        `DELETE FROM git_tree_entries WHERE source_key = (
           SELECT source_key FROM git_tree_sources
            WHERE repo_id = ? AND tree_oid = ? AND complete = 0
         )`,
        repoId,
        treeOid,
      );
      return false;
    }
  }

  #live(): TreeIndexBuffers {
    if (this.#buffers === null) throw new Error("tree index batch is disposed");
    return this.#buffers;
  }

  #rows(): TreeIndexRows {
    return this.#live().rows;
  }
}

export class TreeSourceIndexer {
  readonly #slot: TreeSourceSlot | null;
  #count = 0;
  #receivedBytes = 0;
  #observedSize = 0;
  #baseCost = 0;
  #finished = false;
  #cacheAvailable = true;

  constructor(
    private readonly source: TreeSource,
    private readonly batch: TreeIndexBatch,
    write = true,
  ) {
    if (write) {
      this.#slot = batch.open(source);
    } else {
      validateTreeSource(source);
      this.#slot = null;
    }
  }

  acceptChunk(length: number): void {
    if (this.#finished) throw new Error("tree index source is already finished");
    if (length > this.source.objectSize - this.#receivedBytes) {
      throw new CorruptError(`tree ${this.source.treeOid} exceeds its declared size`);
    }
    this.#receivedBytes += length;
  }

  push(parsed: ParsedTreeEntry): void {
    if (this.#finished) throw new Error("tree index source is already finished");
    validateParsedTreeEntry(parsed);
    this.#observedSize = parsed.observedSize;
    this.#baseCost +=
      TREE_QUEUE_ROW_FIXED_BYTES +
      parsed.nameBytes.length +
      parsed.entry.mode.length +
      parsed.entry.oid.length;
    if (!Number.isSafeInteger(this.#baseCost)) {
      throw new CorruptError("tree index cost exceeds the safe integer range");
    }
    if (this.#slot !== null && this.#cacheAvailable) {
      this.#cacheAvailable = this.batch.addEntry(this.#slot, parsed, this.#baseCost);
    }
    this.#count++;
  }

  finish(parsed: TreeParseResult): void {
    if (this.#finished) throw new Error("tree index source is already finished");
    this.#finished = true;
    if (
      this.#receivedBytes !== parsed.observedSize ||
      this.#observedSize !== this.source.objectSize
    ) {
      throw new CorruptError(
        `tree ${this.source.treeOid} parsed ${parsed.observedSize} bytes, expected ${this.source.objectSize}`,
      );
    }
    if (this.#slot !== null && this.#cacheAvailable) {
      this.batch.addMarker(this.#slot, this.#count, this.#baseCost);
    }
  }
}
