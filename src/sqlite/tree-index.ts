import { isOid, utf8, utf8Decoder } from "../core/bytes.js";
import { CorruptError } from "../core/errors.js";
import { type ParsedTreeEntry, type TreeParseResult, TreeParser } from "../core/objects.js";
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
// The two arenas own 896 KiB; this reserve covers their wrappers and scalar state.
const TREE_INDEX_FIXED_BYTES = 64 * 1024;
const TREE_INDEX_MEMORY_BYTES = 1024 * 1024;
const TREE_INDEX_ROW_FIXED_BYTES = 192;
const TREE_INDEX_MARKER_FIXED_BYTES = 192;
const TREE_MODE = /^(?:0?40000|100644|100755|120000|160000)$/;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let at = 0; at < left.length; at++) {
    if (left[at] !== right[at]) return false;
  }
  return true;
}

function validateParsedTreeEntry(parsed: ParsedTreeEntry): void {
  const { entry, nameBytes, rawEntry } = parsed;
  if (!TREE_MODE.test(entry.mode)) throw new CorruptError(`invalid tree mode ${entry.mode}`);
  if (
    entry.name === "" ||
    entry.name.includes("/") ||
    nameBytes.length > 2_200 ||
    nameBytes.includes(0) ||
    utf8Decoder.decode(nameBytes) !== entry.name
  ) {
    throw new CorruptError("invalid tree entry name");
  }
  if (!isOid(entry.oid)) throw new CorruptError("invalid tree entry oid");
  const modeBytes = utf8.encode(entry.mode);
  const expectedLength = modeBytes.length + nameBytes.length + 22;
  const modeEnd = modeBytes.length;
  const nameAt = modeEnd + 1;
  const oidAt = nameAt + nameBytes.length + 1;
  if (
    rawEntry.length !== expectedLength ||
    !equalBytes(rawEntry.subarray(0, modeEnd), modeBytes) ||
    rawEntry[modeEnd] !== 0x20 ||
    !equalBytes(rawEntry.subarray(nameAt, oidAt - 1), nameBytes) ||
    rawEntry[oidAt - 1] !== 0
  ) {
    throw new CorruptError("tree entry raw bytes disagree with parsed fields");
  }
  for (let at = 0; at < 20; at++) {
    if (rawEntry[oidAt + at] !== Number.parseInt(entry.oid.slice(at * 2, at * 2 + 2), 16)) {
      throw new CorruptError("tree entry raw bytes disagree with parsed fields");
    }
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
      throw new CorruptError("tree entry exceeds the index buffer limit");
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
  readonly #entries = new TreeEntryArena();
  readonly #markers = new AsciiJsonArray(TREE_INDEX_MARKER_JSON_BYTES);
  #peakBytes = TREE_INDEX_ENTRY_ARENA_BYTES + TREE_INDEX_MARKER_JSON_BYTES + TREE_INDEX_FIXED_BYTES;
  #sourcesSeeded: boolean;

  constructor(
    private readonly db: SqlDatabase,
    sourcesSeeded = false,
    private readonly seedOnce = false,
    private readonly requireSeededSources = false,
  ) {
    this.#sourcesSeeded = sourcesSeeded;
  }

  get retainedBytes(): number {
    return TREE_INDEX_ENTRY_ARENA_BYTES + TREE_INDEX_MARKER_JSON_BYTES + TREE_INDEX_FIXED_BYTES;
  }

  get peakBytes(): number {
    return this.#peakBytes;
  }

  get retainedRows(): number {
    return this.#entries.rows + this.#markers.rows;
  }

  addEntry(source: TreeSource, parsed: ParsedTreeEntry, cumulativeBase: number): void {
    const payloadBytes = parsed.rawEntry.length;
    const rawAt = this.#entries.payloadLength + 1;
    const nameAt = rawAt + parsed.entry.mode.length + 1;
    let json = `{"p":${source.repoId},"t":"${source.treeOid}","s":"${source.storage}","x":${source.sourceId},"b":${source.objectSize},"q":${parsed.ordinal},"m":"${parsed.entry.mode}","o":"${parsed.entry.oid}","a":${nameAt},"l":${parsed.nameBytes.length},"r":${rawAt},"z":${parsed.rawEntry.length},"c":${cumulativeBase}}`;
    if (this.retainedRows >= TREE_INDEX_ROWS || !this.#entries.canAppend(payloadBytes, json)) {
      this.flush();
      json = `{"p":${source.repoId},"t":"${source.treeOid}","s":"${source.storage}","x":${source.sourceId},"b":${source.objectSize},"q":${parsed.ordinal},"m":"${parsed.entry.mode}","o":"${parsed.entry.oid}","a":${parsed.entry.mode.length + 2},"l":${parsed.nameBytes.length},"r":1,"z":${parsed.rawEntry.length},"c":${cumulativeBase}}`;
    }
    this.#entries.append(parsed.rawEntry, json);
    this.#observeTransient(
      parsed.nameBytes.length * 2 +
        parsed.rawEntry.length +
        json.length * 2 +
        TREE_INDEX_ROW_FIXED_BYTES,
    );
  }

  addMarker(source: TreeSource, count: number, baseCost: number): void {
    const json = `{"p":${source.repoId},"t":"${source.treeOid}","s":"${source.storage}","x":${source.sourceId},"z":${source.objectSize},"n":${count},"b":${baseCost}}`;
    if (json.length + 2 > this.#markers.bytes.length) {
      throw new CorruptError("tree source marker exceeds the index buffer limit");
    }
    if (this.retainedRows >= TREE_INDEX_ROWS || !this.#markers.canAppend(json)) {
      this.flush();
    }
    this.#markers.append(json);
    this.#observeTransient(
      json.length * 2 + source.treeOid.length * 2 + TREE_INDEX_MARKER_FIXED_BYTES,
    );
  }

  flush(): void {
    this.#flushEntries();
    this.#flushMarkers();
  }

  #flushEntries(): void {
    if (this.#entries.rows === 0) return;
    const json = this.#entries.seal();
    if (!this.#sourcesSeeded) {
      this.db.run(
        `INSERT OR IGNORE INTO git_tree_sources
         (repo_id, tree_oid, storage, source_id, complete, object_size, entry_count, base_cost)
       SELECT json_extract(j.value, '$.p'), json_extract(j.value, '$.t'),
              json_extract(j.value, '$.s'), json_extract(j.value, '$.x'),
              0, json_extract(j.value, '$.b'), NULL, NULL
         FROM json_each(CAST(substr(?, ?, ?) AS TEXT)) j`,
        blob(this.#entries.bytes),
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
         FROM (SELECT ? AS ignored) guard
         CROSS JOIN json_each(CAST(substr(?, ?, ?) AS TEXT)) j
         JOIN git_tree_sources s
           ON s.repo_id = json_extract(j.value, '$.p')
          AND s.tree_oid = json_extract(j.value, '$.t')
          AND s.storage = json_extract(j.value, '$.s')
          AND s.source_id = json_extract(j.value, '$.x')
        WHERE typeof(guard.ignored) = 'blob'`,
      blob(this.#entries.bytes),
      blob(this.#entries.bytes),
      blob(this.#entries.bytes),
      blob(this.#entries.bytes),
      json.offset,
      json.length,
    );
    this.#entries.reset();
  }

  #flushMarkers(): void {
    if (this.#markers.rows === 0) return;
    const markerRows = this.#markers.rows;
    const jsonLength = this.#markers.seal();
    if (this.requireSeededSources) {
      const returned = this.db.all<{ source_key: unknown }>(
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
        blob(this.#markers.bytes),
        jsonLength,
      );
      if (
        returned.length !== markerRows ||
        returned.some(
          (row) =>
            typeof row.source_key !== "number" ||
            !Number.isSafeInteger(row.source_key) ||
            row.source_key < 1,
        )
      ) {
        throw new CorruptError("tree index source was not seeded");
      }
      this.#markers.reset();
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
      blob(this.#markers.bytes),
      jsonLength,
    );
    this.#markers.reset();
  }

  #observeTransient(bytes: number): void {
    this.#peakBytes = Math.max(this.#peakBytes, this.retainedBytes + bytes);
    if (this.#peakBytes > TREE_INDEX_MEMORY_BYTES) {
      throw new CorruptError("tree index exceeds its memory limit");
    }
  }
}

function seedTreeSources(db: SqlDatabase, sources: readonly TreeSourceInput[]): void {
  if (sources.length === 0) return;
  const rows = sources.map((source) => ({
    p: source.repoId,
    t: source.treeOid,
    s: source.storage,
    x: source.sourceId,
    z: source.objectSize,
  }));
  const json = JSON.stringify(rows);
  if (utf8.encode(json).length > TREE_INDEX_ENTRY_ARENA_BYTES) {
    throw new CorruptError("tree source preflight exceeds the index buffer limit");
  }
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

  constructor(
    private readonly source: TreeSource,
    private readonly batch: TreeIndexBatch,
    private readonly writeEntries = true,
    private readonly writeMarker = true,
  ) {
    if (
      !Number.isSafeInteger(source.repoId) ||
      source.repoId < 0 ||
      !isOid(source.treeOid) ||
      (source.storage !== "loose" && source.storage !== "pack") ||
      !Number.isSafeInteger(source.sourceId) ||
      source.sourceId < 0 ||
      !Number.isSafeInteger(source.objectSize) ||
      source.objectSize < 0
    ) {
      throw new CorruptError("tree source has invalid metadata");
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
    if (
      parsed.ordinal !== this.#count ||
      parsed.observedSize !== this.#observedSize + parsed.rawEntry.length
    ) {
      throw new CorruptError("tree parser progress is inconsistent");
    }
    this.#observedSize = parsed.observedSize;
    this.#baseCost +=
      TREE_QUEUE_ROW_FIXED_BYTES +
      parsed.nameBytes.length +
      parsed.entry.mode.length +
      parsed.entry.oid.length;
    if (!Number.isSafeInteger(this.#baseCost)) {
      throw new CorruptError("tree index cost exceeds the safe integer range");
    }
    if (this.writeEntries) this.batch.addEntry(this.source, parsed, this.#baseCost);
    this.#count++;
  }

  finish(parsed: TreeParseResult): void {
    if (this.#finished) throw new Error("tree index source is already finished");
    this.#finished = true;
    if (
      parsed.entryCount !== this.#count ||
      parsed.observedSize !== this.#observedSize ||
      this.#receivedBytes !== parsed.observedSize ||
      this.#observedSize !== this.source.objectSize
    ) {
      throw new CorruptError(
        `tree ${this.source.treeOid} parsed ${parsed.observedSize} bytes, expected ${this.source.objectSize}`,
      );
    }
    if (this.writeMarker) this.batch.addMarker(this.source, this.#count, this.#baseCost);
  }
}

/** Incrementally parse and index one tree. The caller owns the transaction. */
export class TreeIndexSink {
  readonly #parser = new TreeParser();
  readonly #batch: TreeIndexBatch;
  readonly #source: TreeSourceIndexer;
  #finished = false;
  #peakBytes = 0;

  constructor(db: SqlDatabase, source: TreeSource) {
    this.#batch = new TreeIndexBatch(db, false, true);
    this.#source = new TreeSourceIndexer(source, this.#batch);
    this.#observePeak();
  }

  get retainedBytes(): number {
    return this.#parser.retainedBytes + this.#batch.retainedBytes;
  }

  get retainedRows(): number {
    return this.#batch.retainedRows;
  }

  get peakBytes(): number {
    return this.#peakBytes;
  }

  push(chunk: Uint8Array): void {
    if (this.#finished) throw new Error("tree index sink is already finished");
    this.#source.acceptChunk(chunk.length);
    try {
      for (const parsed of this.#parser.push(chunk)) this.#source.push(parsed);
    } finally {
      this.#observePeak();
    }
  }

  finish(): void {
    if (this.#finished) throw new Error("tree index sink is already finished");
    this.#finished = true;
    this.#source.finish(this.#parser.finish());
    this.#batch.flush();
    this.#observePeak();
  }

  #observePeak(): void {
    this.#peakBytes = Math.max(this.#peakBytes, this.#parser.retainedBytes + this.#batch.peakBytes);
    if (this.#peakBytes > TREE_INDEX_MEMORY_BYTES) {
      throw new CorruptError("tree index exceeds its memory limit");
    }
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
    const indexer = new TreeSourceIndexer(source, batch, writeEntries, writeMarkers);
    for (const chunk of source.chunks) {
      indexer.acceptChunk(chunk.length);
      for (const parsed of parser.push(chunk)) indexer.push(parsed);
    }
    indexer.finish(parser.finish());
  }
  batch.flush();
}

/** Write exact parsed-tree sources. The caller owns the transaction. */
export function indexTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  if (
    Array.isArray(sources) &&
    sources.every((source: TreeSourceInput) => Array.isArray(source.chunks))
  ) {
    seedTreeSources(db, sources);
    const batch = new TreeIndexBatch(db, true);
    indexTreePass(batch, sources, true, false);
    indexTreePass(batch, sources, false, true);
    return;
  }
  indexTreePass(new TreeIndexBatch(db), sources, true, true);
}

/** Index loose trees whose object insert already seeded incomplete source rows. */
export function indexSeededTreeSources(db: SqlDatabase, sources: Iterable<TreeSourceInput>): void {
  if (
    Array.isArray(sources) &&
    sources.every((source: TreeSourceInput) => Array.isArray(source.chunks))
  ) {
    const batch = new TreeIndexBatch(db, true, false, true);
    indexTreePass(batch, sources, true, false);
    indexTreePass(batch, sources, false, true);
    return;
  }
  indexTreePass(new TreeIndexBatch(db, true, false, true), sources, true, true);
}

/** Index one loose tree whose object insert already seeded its incomplete source row. */
export function indexSeededTreeSource(
  db: SqlDatabase,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
): void {
  indexTreePass(new TreeIndexBatch(db, true, false, true), [{ ...source, chunks }], true, true);
}

/** Write one exact parsed-tree source. The caller owns the transaction. */
export function indexTreeSource(
  db: SqlDatabase,
  source: TreeSource,
  chunks: Iterable<Uint8Array>,
): void {
  const sink = createTreeIndexSink(db, source);
  for (const chunk of chunks) sink.push(chunk);
  sink.finish();
}
