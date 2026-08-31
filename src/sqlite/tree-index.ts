import { isOid } from "../core/bytes.js";
import { CorruptError, hasErrorCode } from "../core/errors.js";
import { type ParsedTreeEntry, type TreeParseResult, TreeParser } from "../core/objects.js";
import { expectSafeInteger } from "../core/rows.js";
import { blob, type SqlDatabase } from "./db.js";

/** SQLite queue record, four integer fields, and bounded error fields. */
export const TREE_QUEUE_ROW_FIXED_BYTES = 64 + 4 * 8 + 96;

export type TreeStorage = "loose" | "pack";

export interface TreeSource {
  repoId: number;
  treeOid: string;
  storage: TreeStorage;
  sourceId: number;
  objectSize: number;
}

export interface TreeSourceInput extends TreeSource {
  chunks: Iterable<Uint8Array>;
}

const TREE_INDEX_ROWS = 2048;
const TREE_INDEX_ENTRY_ARENA_BYTES = 704 * 1024;
const TREE_INDEX_MARKER_JSON_BYTES = 192 * 1024;
const TREE_MODE = /^(?:0?40000|100644|100755|120000|160000)$/;

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
  expectSafeInteger(source.sourceId, 0, Number.MAX_SAFE_INTEGER, "tree source id");
  expectSafeInteger(source.objectSize, 0, Number.MAX_SAFE_INTEGER, "tree source object size");
  if (!isOid(source.treeOid) || (source.storage !== "loose" && source.storage !== "pack")) {
    throw new CorruptError("tree source has invalid metadata");
  }
}

class AsciiJsonArray {
  readonly bytes: Uint8Array;
  #length = 1;
  #rows = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
    this.bytes[0] = 0x5b;
  }

  get rows(): number {
    return this.#rows;
  }

  get encodedLength(): number {
    return this.#length + 1;
  }

  canAppend(value: string): boolean {
    return this.#length + (this.#rows === 0 ? 0 : 1) + value.length + 1 <= this.bytes.length;
  }

  append(value: string): void {
    if (!this.canAppend(value)) throw new CorruptError("tree index JSON row exceeds its buffer");
    if (this.#rows !== 0) this.bytes[this.#length++] = 0x2c;
    for (let at = 0; at < value.length; at++) {
      const byte = value.charCodeAt(at);
      if (byte > 0x7f) throw new CorruptError("tree index JSON row is not ASCII");
      this.bytes[this.#length++] = byte;
    }
    this.#rows++;
  }

  seal(): number {
    this.bytes[this.#length] = 0x5d;
    return this.#length + 1;
  }

  reset(): void {
    this.#length = 1;
    this.#rows = 0;
    this.bytes[0] = 0x5b;
  }
}

class TreeEntryArena {
  readonly bytes = new Uint8Array(TREE_INDEX_ENTRY_ARENA_BYTES);
  #payloadLength = 0;
  #jsonStart = this.bytes.length - 1;
  #rows = 0;

  constructor() {
    this.bytes[this.#jsonStart] = 0x5d;
  }

  get payloadLength(): number {
    return this.#payloadLength;
  }

  get rows(): number {
    return this.#rows;
  }

  canAppend(payloadLength: number, json: string): boolean {
    const jsonBytes = json.length + (this.#rows === 0 ? 0 : 1);
    return this.#payloadLength + payloadLength < this.#jsonStart - jsonBytes;
  }

  append(payload: Uint8Array, json: string): void {
    if (!this.canAppend(payload.length, json)) {
      throw new CorruptError("tree entry arena capacity changed after admission");
    }
    this.bytes.set(payload, this.#payloadLength);
    this.#payloadLength += payload.length;
    if (this.#rows !== 0) this.bytes[--this.#jsonStart] = 0x2c;
    this.#jsonStart -= json.length;
    for (let at = 0; at < json.length; at++) {
      const byte = json.charCodeAt(at);
      if (byte > 0x7f) throw new CorruptError("tree index JSON row is not ASCII");
      this.bytes[this.#jsonStart + at] = byte;
    }
    this.#rows++;
  }

  seal(): { offset: number; length: number } {
    this.bytes[--this.#jsonStart] = 0x5b;
    return { offset: this.#jsonStart + 1, length: this.bytes.length - this.#jsonStart };
  }

  reset(): void {
    this.#payloadLength = 0;
    this.#jsonStart = this.bytes.length - 1;
    this.#rows = 0;
    this.bytes[this.#jsonStart] = 0x5d;
  }
}

class TreeIndexBatch {
  #entries: TreeEntryArena | null;
  #markers: AsciiJsonArray | null;
  #sourcesSeeded: boolean;

  constructor(
    private readonly db: SqlDatabase,
    sourcesSeeded = false,
    private readonly seedOnce = false,
    private readonly requireSeededSources = false,
  ) {
    this.#sourcesSeeded = sourcesSeeded;
    this.#entries = new TreeEntryArena();
    this.#markers = new AsciiJsonArray(TREE_INDEX_MARKER_JSON_BYTES);
  }

  get retainedRows(): number {
    return this.#entryArena().rows + this.#markerArena().rows;
  }

  addEntry(source: TreeSource, parsed: ParsedTreeEntry, cumulativeBase: number): boolean {
    let entries = this.#entryArena();
    const payloadBytes = parsed.rawEntry.length;
    const rawAt = entries.payloadLength + 1;
    const nameAt = rawAt + parsed.entry.mode.length + 1;
    return (() => {
      let json = `{"p":${source.repoId},"t":"${source.treeOid}","s":"${source.storage}","x":${source.sourceId},"b":${source.objectSize},"q":${parsed.ordinal},"m":"${parsed.entry.mode}","o":"${parsed.entry.oid}","a":${nameAt},"l":${parsed.nameBytes.length},"r":${rawAt},"z":${parsed.rawEntry.length},"c":${cumulativeBase}}`;
      if (this.retainedRows >= TREE_INDEX_ROWS || !entries.canAppend(payloadBytes, json)) {
        this.flush();
        entries = this.#entryArena();
        json = `{"p":${source.repoId},"t":"${source.treeOid}","s":"${source.storage}","x":${source.sourceId},"b":${source.objectSize},"q":${parsed.ordinal},"m":"${parsed.entry.mode}","o":"${parsed.entry.oid}","a":${parsed.entry.mode.length + 2},"l":${parsed.nameBytes.length},"r":1,"z":${parsed.rawEntry.length},"c":${cumulativeBase}}`;
      }
      if (!entries.canAppend(payloadBytes, json)) {
        return this.#insertOversizedEntry(source, parsed, cumulativeBase);
      }
      entries.append(parsed.rawEntry, json);
      return true;
    })();
  }

  #insertOversizedEntry(
    source: TreeSource,
    parsed: ParsedTreeEntry,
    cumulativeBase: number,
  ): boolean {
    if (!this.#sourcesSeeded) {
      this.#seedSource(source);
      if (this.seedOnce) this.#sourcesSeeded = true;
    }
    try {
      this.db.run(
        `INSERT INTO git_tree_entries
             (source_key, ordinal, mode, name_bytes, oid, raw_entry, cumulative_base)
           SELECT source.source_key, ?, ?, ?, ?, ?, ?
             FROM git_tree_sources source
            WHERE source.repo_id = ? AND source.tree_oid = ?
              AND source.storage = ? AND source.source_id = ?`,
        parsed.ordinal,
        parsed.entry.mode,
        blob(parsed.nameBytes),
        parsed.entry.oid,
        blob(parsed.rawEntry),
        cumulativeBase,
        source.repoId,
        source.treeOid,
        source.storage,
        source.sourceId,
      );
      return true;
    } catch (error) {
      if (!hasErrorCode(error, "E2BIG")) throw error;
      this.#leaveSourceUnavailable(source);
      return false;
    }
  }

  #seedSource(source: TreeSource): void {
    this.db.run(
      `INSERT OR IGNORE INTO git_tree_sources
         (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
       VALUES (?, ?, ?, ?, 0, ?, NULL, NULL)`,
      source.repoId,
      source.treeOid,
      source.storage,
      source.sourceId,
      source.objectSize,
    );
  }

  #leaveSourceUnavailable(source: TreeSource): void {
    this.db.run(
      `DELETE FROM git_tree_entries WHERE source_key = (
         SELECT source_key FROM git_tree_sources
          WHERE repo_id = ? AND tree_oid = ? AND storage = ? AND source_id = ?
       )`,
      source.repoId,
      source.treeOid,
      source.storage,
      source.sourceId,
    );
    this.db.run(
      `UPDATE git_tree_sources
          SET complete = 0, entry_count = NULL, base_cost = NULL
        WHERE repo_id = ? AND tree_oid = ? AND storage = ? AND source_id = ?`,
      source.repoId,
      source.treeOid,
      source.storage,
      source.sourceId,
    );
  }

  addMarker(source: TreeSource, count: number, baseCost: number): void {
    (() => {
      const markers = this.#markerArena();
      const json = `{"p":${source.repoId},"t":"${source.treeOid}","s":"${source.storage}","x":${source.sourceId},"z":${source.objectSize},"n":${count},"b":${baseCost}}`;
      if (json.length + 2 > markers.bytes.length) {
        throw new CorruptError("tree source marker exceeds the index buffer limit");
      }
      if (this.retainedRows >= TREE_INDEX_ROWS || !markers.canAppend(json)) {
        this.flush();
      }
      this.#markerArena().append(json);
    })();
  }

  flush(): void {
    this.#flushEntries();
    this.#flushMarkers();
  }

  #flushEntries(): void {
    const entries = this.#entryArena();
    if (entries.rows === 0) return;
    const json = entries.seal();
    if (!this.#sourcesSeeded) {
      this.db.run(
        `INSERT OR IGNORE INTO git_tree_sources
         (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
       SELECT json_extract(j.value, '$.p'), json_extract(j.value, '$.t'),
              json_extract(j.value, '$.s'), json_extract(j.value, '$.x'),
              0, json_extract(j.value, '$.b'), NULL, NULL
         FROM json_each(CAST(substr(?, ?, ?) AS TEXT)) j`,
        blob(entries.bytes),
        json.offset,
        json.length,
      );
      if (this.seedOnce) this.#sourcesSeeded = true;
    }
    this.db.run(
      `INSERT INTO git_tree_entries
         (source_key, ordinal, mode, name_bytes, oid, raw_entry, cumulative_base)
       SELECT s.source_key, json_extract(j.value, '$.q'), json_extract(j.value, '$.m'),
              substr(?, json_extract(j.value, '$.a'), json_extract(j.value, '$.l')),
              json_extract(j.value, '$.o'),
              substr(?, json_extract(j.value, '$.r'), json_extract(j.value, '$.z')),
              json_extract(j.value, '$.c')
         FROM json_each(CAST(substr(?, ?, ?) AS TEXT)) j
         JOIN git_tree_sources s
           ON s.repo_id = json_extract(j.value, '$.p')
          AND s.tree_oid = json_extract(j.value, '$.t')
          AND s.storage = json_extract(j.value, '$.s')
          AND s.source_id = json_extract(j.value, '$.x')`,
      blob(entries.bytes),
      blob(entries.bytes),
      blob(entries.bytes),
      json.offset,
      json.length,
    );
    entries.reset();
  }

  #flushMarkers(): void {
    const markers = this.#markerArena();
    if (markers.rows === 0) return;
    const markerRows = markers.rows;
    const jsonLength = markers.seal();
    if (this.requireSeededSources) {
      let returnedRows = 0;
      for (const _row of this.db.iterate(
        `INSERT INTO git_tree_sources
               (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
             SELECT existing.repo_id, existing.tree_oid, existing.storage, existing.source_id,
                    1, json_extract(marker.value, '$.z'), json_extract(marker.value, '$.n'),
                    json_extract(marker.value, '$.b')
               FROM json_each(CAST(substr(?, 1, ?) AS TEXT)) marker
               JOIN git_tree_sources existing
                 ON existing.repo_id = json_extract(marker.value, '$.p')
                AND existing.tree_oid = json_extract(marker.value, '$.t')
                AND existing.storage = json_extract(marker.value, '$.s')
                AND existing.source_id = json_extract(marker.value, '$.x')
              WHERE true
             ON CONFLICT(repo_id, tree_oid, storage, source_id) DO UPDATE SET
               complete = 1, object_size = excluded.object_size,
               entry_count = excluded.entry_count, base_cost = excluded.base_cost
             RETURNING source_key`,
        blob(markers.bytes),
        jsonLength,
      )) {
        returnedRows++;
        if (returnedRows > markerRows) {
          throw new CorruptError("tree index source was not seeded");
        }
      }
      if (returnedRows !== markerRows) {
        throw new CorruptError("tree index source was not seeded");
      }
      markers.reset();
      return;
    }
    this.db.run(
      `INSERT INTO git_tree_sources
         (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
       SELECT json_extract(value, '$.p'), json_extract(value, '$.t'),
              json_extract(value, '$.s'), json_extract(value, '$.x'),
              1, json_extract(value, '$.z'), json_extract(value, '$.n'),
              json_extract(value, '$.b')
         FROM json_each(CAST(substr(?, 1, ?) AS TEXT))
        WHERE true
       ON CONFLICT(repo_id, tree_oid, storage, source_id) DO UPDATE SET
         complete = 1, object_size = excluded.object_size,
         entry_count = excluded.entry_count, base_cost = excluded.base_cost`,
      blob(markers.bytes),
      jsonLength,
    );
    markers.reset();
  }

  dispose(): void {
    if (this.#entries === null) return;
    this.#entries = null;
    this.#markers = null;
  }

  #entryArena(): TreeEntryArena {
    if (this.#entries === null) throw new Error("tree index batch is disposed");
    return this.#entries;
  }

  #markerArena(): AsciiJsonArray {
    if (this.#markers === null) throw new Error("tree index batch is disposed");
    return this.#markers;
  }
}

function seedTreeSources(db: SqlDatabase, sources: readonly TreeSourceInput[]): void {
  if (sources.length === 0) return;
  for (const source of sources) validateTreeSource(source);
  const rows = sources.map((source) => ({
    p: source.repoId,
    t: source.treeOid,
    s: source.storage,
    x: source.sourceId,
    z: source.objectSize,
  }));
  const json = JSON.stringify(rows);
  db.run(
    `INSERT OR IGNORE INTO git_tree_sources
         (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
       SELECT json_extract(value, '$.p'), json_extract(value, '$.t'),
              json_extract(value, '$.s'), json_extract(value, '$.x'),
              0, json_extract(value, '$.z'), NULL, NULL
         FROM json_each(?)`,
    json,
  );
}

class TreeSourceIndexer {
  #count = 0;
  #receivedBytes = 0;
  #observedSize = 0;
  #baseCost = 0;
  #finished = false;
  #cacheAvailable = true;

  constructor(
    private readonly source: TreeSource,
    private readonly batch: TreeIndexBatch,
    private readonly writeEntries = true,
    private readonly writeMarker = true,
  ) {
    validateTreeSource(source);
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
    if (this.writeEntries && this.#cacheAvailable) {
      this.#cacheAvailable = this.batch.addEntry(this.source, parsed, this.#baseCost);
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
    if (this.writeMarker && this.#cacheAvailable) {
      this.batch.addMarker(this.source, this.#count, this.#baseCost);
    }
  }
}

/** Incrementally parse and index one tree. The caller owns the transaction. */
export class TreeIndexSink {
  readonly #parser: TreeParser;
  readonly #batch: TreeIndexBatch;
  readonly #source: TreeSourceIndexer;
  #finished = false;

  constructor(db: SqlDatabase, source: TreeSource) {
    this.#parser = new TreeParser();
    try {
      this.#batch = new TreeIndexBatch(db, false, true, false);
    } catch (error) {
      this.#parser.dispose();
      throw error;
    }
    try {
      this.#source = new TreeSourceIndexer(source, this.#batch);
    } catch (error) {
      this.#parser.dispose();
      this.#batch.dispose();
      throw error;
    }
  }

  get retainedRows(): number {
    return this.#batch.retainedRows;
  }

  push(chunk: Uint8Array): void {
    if (this.#finished) throw new Error("tree index sink is already finished");
    try {
      this.#source.acceptChunk(chunk.length);
      for (const parsed of this.#parser.push(chunk)) this.#source.push(parsed);
    } catch (error) {
      this.#dispose();
      throw error;
    }
  }

  finish(): void {
    if (this.#finished) throw new Error("tree index sink is already finished");
    this.#finished = true;
    try {
      this.#source.finish(this.#parser.finish());
      this.#batch.flush();
    } finally {
      this.#dispose();
    }
  }

  dispose(): void {
    this.#dispose();
  }

  #dispose(): void {
    this.#finished = true;
    this.#parser.dispose();
    this.#batch.dispose();
  }
}

export function createTreeIndexSink(db: SqlDatabase, source: TreeSource): TreeIndexSink {
  return new TreeIndexSink(db, source);
}

function indexTreePass(
  batch: TreeIndexBatch,
  sources: Iterable<TreeSourceInput>,
  writeEntries: boolean,
  writeMarkers: boolean,
): void {
  for (const source of sources) {
    const parser = new TreeParser();
    try {
      const indexer = new TreeSourceIndexer(source, batch, writeEntries, writeMarkers);
      for (const chunk of source.chunks) {
        indexer.acceptChunk(chunk.length);
        for (const parsed of parser.push(chunk)) indexer.push(parsed);
      }
      indexer.finish(parser.finish());
    } finally {
      parser.dispose();
    }
  }
  batch.flush();
}

/** Write exact parsed-tree sources. The caller owns the transaction. */
export function indexTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  const arraySources = Array.isArray(sources) ? sources : null;
  if (arraySources?.every((source: TreeSourceInput) => Array.isArray(source.chunks))) {
    seedTreeSources(db, arraySources);
    const batch = new TreeIndexBatch(db, true, false, false);
    try {
      indexTreePass(batch, arraySources, true, true);
    } finally {
      batch.dispose();
    }
    return;
  }
  const batch = new TreeIndexBatch(db, false, false, false);
  try {
    indexTreePass(batch, sources, true, true);
  } finally {
    batch.dispose();
  }
}

/** Index loose trees whose object insert already seeded incomplete source rows. */
export function indexSeededTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  const batch = new TreeIndexBatch(db, true, false, true);
  try {
    indexTreePass(batch, sources, true, true);
  } finally {
    batch.dispose();
  }
}

/** Index one loose tree whose object insert already seeded its incomplete source row. */
export function indexSeededTreeSource(
  db: SqlDatabase,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
): void {
  indexSeededTreeSources(db, [{ ...source, chunks }]);
}

/** Write one exact parsed-tree source. The caller owns the transaction. */
export function indexTreeSource(
  db: SqlDatabase,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
): void {
  const sink = createTreeIndexSink(db, source);
  try {
    for (const chunk of chunks) sink.push(chunk);
    sink.finish();
  } finally {
    sink.dispose();
  }
}
