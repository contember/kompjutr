import { CorruptError } from "../../common/errors.js";
import type { ParsedTreeEntry } from "../../common/objects.js";
import type { TreeSource } from "./tree-index.js";

/** Entry or marker rows per statement window. */
export const TREE_INDEX_ROWS = 2048;
/** Rows the deferred pack batch retains until its transaction. */
export const TREE_INDEX_DEFERRED_ROWS = 16 * TREE_INDEX_ROWS;
/** Smallest valid entry: a five-byte mode, a space, a one-byte name, NUL, and a raw OID. */
const TREE_ENTRY_MIN_BYTES = 28;
const TREE_INDEX_ENTRY_ARENA_BYTES = 704 * 1024;
const TREE_INDEX_MARKER_ARENA_BYTES = 192 * 1024;
const OID_BYTES = 20;
const OID_HEX_BYTES = 40;
/** Two brackets, six commas, and the quotes around mode and OID in one entry row. */
const ENTRY_ROW_PUNCTUATION = 2 + 6 + 4;
/** Two brackets, four commas, and the quotes around the tree OID in one marker row. */
const MARKER_ROW_PUNCTUATION = 2 + 4 + 2;
const MAX_ORDINAL = 0xffff_ffff;
const ASCII = new TextEncoder();
const HEX_DIGITS = ASCII.encode("0123456789abcdef");
const MODES = ["40000", "040000", "100644", "100755", "120000", "160000"] as const;
const MODE_BYTES = MODES.map((mode) => ASCII.encode(mode));
const MODE_CODES = new Map<string, number>(MODES.map((mode, code) => [mode, code]));

function modeCode(mode: string): number {
  const code = MODE_CODES.get(mode);
  if (code === undefined) throw new CorruptError(`invalid tree mode ${mode}`);
  return code;
}

/** A source's entries plus its marker, if every entry had the smallest valid size. */
function worstCaseRows(objectBytes: number): number {
  return Math.floor(objectBytes / TREE_ENTRY_MIN_BYTES) + 1;
}

/** The value of one lowercase hex digit; OIDs are validated before they reach a row. */
function hexValue(code: number): number {
  return code <= 0x39 ? code - 0x30 : code - 0x57;
}

function digitCount(value: number): number {
  let digits = 1;
  for (let rest = value; rest >= 10; rest = Math.floor(rest / 10)) digits++;
  return digits;
}

function writeInteger(bytes: Uint8Array, at: number, value: number): number {
  const end = at + digitCount(value);
  let cursor = end;
  let rest = value;
  do {
    bytes[--cursor] = 0x30 + (rest % 10);
    rest = Math.floor(rest / 10);
  } while (rest > 0);
  return end;
}

/** One serialized window: rows of JSON after their names, inside a whole bindable buffer. */
export interface TreeIndexWindow {
  rows: number;
  /** Batch-local positions of the first and last source the window's rows name. */
  firstSource: number;
  lastSource: number;
  jsonOffset: number;
  jsonLength: number;
}

/**
 * Parsed entries and markers retained until a flush. Rows name a batch-local
 * source position; JSON is written per statement window at the flush.
 */
export class TreeIndexRows {
  readonly #source: Uint32Array;
  readonly #ordinal: Uint32Array;
  readonly #cumulative: Float64Array;
  readonly #nameEnd: Uint32Array;
  readonly #mode: Uint8Array;
  readonly #oid: Uint8Array;
  readonly #names: Uint8Array;
  readonly #markerSource = new Uint32Array(TREE_INDEX_ROWS);
  readonly #markerCount = new Float64Array(TREE_INDEX_ROWS);
  readonly #markerCost = new Float64Array(TREE_INDEX_ROWS);
  #entries = 0;
  #markers = 0;

  constructor(
    readonly capacity: number,
    readonly nameCapacity: number,
  ) {
    this.#source = new Uint32Array(capacity);
    this.#ordinal = new Uint32Array(capacity);
    this.#cumulative = new Float64Array(capacity);
    this.#nameEnd = new Uint32Array(capacity);
    this.#mode = new Uint8Array(capacity);
    this.#oid = new Uint8Array(capacity * OID_BYTES);
    this.#names = new Uint8Array(nameCapacity);
  }

  get rows(): number {
    return this.#entries + this.#markers;
  }

  get entries(): number {
    return this.#entries;
  }

  get markers(): number {
    return this.#markers;
  }

  /** Whether a source of `objectBytes` raw bytes fits beside the rows already held. */
  holds(objectBytes: number): boolean {
    return (
      this.rows + worstCaseRows(objectBytes) <= this.capacity &&
      this.#markers < TREE_INDEX_ROWS &&
      this.#nameBytes() + objectBytes <= this.nameCapacity
    );
  }

  /** Whether a source of `objectBytes` raw bytes fits once the rows are flushed. */
  holdsAlone(objectBytes: number): boolean {
    return worstCaseRows(objectBytes) <= this.capacity && objectBytes <= this.nameCapacity;
  }

  canAppend(nameLength: number): boolean {
    return this.rows < this.capacity && this.#nameBytes() + nameLength <= this.nameCapacity;
  }

  canMark(): boolean {
    return this.rows < this.capacity && this.#markers < TREE_INDEX_ROWS;
  }

  appendEntry(source: number, parsed: ParsedTreeEntry, cumulativeBase: number): void {
    const row = this.#entries;
    const start = this.#nameBytes();
    const { nameBytes, entry } = parsed;
    if (
      !this.canAppend(nameBytes.length) ||
      entry.oid.length !== OID_HEX_BYTES ||
      parsed.ordinal > MAX_ORDINAL
    ) {
      throw new CorruptError("tree index row exceeds its buffer");
    }
    this.#names.set(nameBytes, start);
    this.#nameEnd[row] = start + nameBytes.length;
    this.#source[row] = source;
    this.#ordinal[row] = parsed.ordinal;
    this.#cumulative[row] = cumulativeBase;
    this.#mode[row] = modeCode(entry.mode);
    const oidAt = row * OID_BYTES;
    for (let at = 0; at < OID_BYTES; at++) {
      this.#oid[oidAt + at] =
        (hexValue(entry.oid.charCodeAt(at * 2)) << 4) | hexValue(entry.oid.charCodeAt(at * 2 + 1));
    }
    this.#entries++;
  }

  appendMarker(source: number, count: number, baseCost: number): void {
    if (!this.canMark()) throw new CorruptError("tree source marker exceeds its buffer");
    this.#markerSource[this.#markers] = source;
    this.#markerCount[this.#markers] = count;
    this.#markerCost[this.#markers] = baseCost;
    this.#markers++;
  }

  /**
   * Serialize entries from `start` into `bytes`: names first, then their JSON
   * array. A row names its source relative to the window's first source, so
   * the statement resolves each source once. Returns the next row.
   */
  fillEntryWindow(start: number, bytes: Uint8Array, window: TreeIndexWindow): number {
    const firstSource = this.#source[start]!;
    let end = start;
    let names = 0;
    let json = 2;
    for (; end < this.#entries && end - start < TREE_INDEX_ROWS; end++) {
      const nameLength = this.#nameLength(end);
      const source = this.#source[end]! - firstSource;
      const rowJson =
        (end === start ? 0 : 1) + this.#entryJsonLength(end, source, names + 1, nameLength);
      if (names + nameLength + json + rowJson > bytes.length) break;
      names += nameLength;
      json += rowJson;
    }
    if (end === start) throw new CorruptError("tree index row exceeds its window");
    let jsonAt = names;
    bytes[jsonAt++] = 0x5b;
    for (let row = start, nameAt = 0; row < end; row++) {
      const nameLength = this.#nameLength(row);
      const nameStart = this.#nameEnd[row]! - nameLength;
      bytes.set(this.#names.subarray(nameStart, nameStart + nameLength), nameAt);
      if (row !== start) bytes[jsonAt++] = 0x2c;
      const source = this.#source[row]! - firstSource;
      jsonAt = this.#writeEntryJson(bytes, jsonAt, row, source, nameAt + 1, nameLength);
      nameAt += nameLength;
    }
    bytes[jsonAt++] = 0x5d;
    if (jsonAt - names !== json) throw new Error("tree index window length was mispredicted");
    window.rows = end - start;
    window.firstSource = firstSource;
    window.lastSource = this.#source[end - 1]!;
    window.jsonOffset = names + 1;
    window.jsonLength = jsonAt - names;
    return end;
  }

  /** Serialize every marker as `[repoId,"treeOid",objectSize,count,baseCost]`; returns the JSON length. */
  fillMarkerWindow(sources: readonly TreeSource[], bytes: Uint8Array): number {
    let at = 0;
    bytes[at++] = 0x5b;
    for (let marker = 0; marker < this.#markers; marker++) {
      const source = sources[this.#markerSource[marker]!];
      if (source === undefined) throw new CorruptError("tree source marker has no source");
      const rowLength =
        (marker === 0 ? 0 : 1) +
        digitCount(source.repoId) +
        OID_HEX_BYTES +
        digitCount(source.objectSize) +
        digitCount(this.#markerCount[marker]!) +
        digitCount(this.#markerCost[marker]!) +
        MARKER_ROW_PUNCTUATION;
      if (at + rowLength + 1 > bytes.length) {
        throw new CorruptError("tree source marker exceeds its window");
      }
      if (marker !== 0) bytes[at++] = 0x2c;
      bytes[at++] = 0x5b;
      at = writeInteger(bytes, at, source.repoId);
      bytes[at++] = 0x2c;
      bytes[at++] = 0x22;
      for (let digit = 0; digit < OID_HEX_BYTES; digit++) {
        bytes[at++] = source.treeOid.charCodeAt(digit);
      }
      bytes[at++] = 0x22;
      bytes[at++] = 0x2c;
      at = writeInteger(bytes, at, source.objectSize);
      bytes[at++] = 0x2c;
      at = writeInteger(bytes, at, this.#markerCount[marker]!);
      bytes[at++] = 0x2c;
      at = writeInteger(bytes, at, this.#markerCost[marker]!);
      bytes[at++] = 0x5d;
    }
    bytes[at++] = 0x5d;
    return at;
  }

  reset(): void {
    this.#entries = 0;
    this.#markers = 0;
  }

  #nameBytes(): number {
    return this.#entries === 0 ? 0 : this.#nameEnd[this.#entries - 1]!;
  }

  #nameLength(row: number): number {
    return this.#nameEnd[row]! - (row === 0 ? 0 : this.#nameEnd[row - 1]!);
  }

  /** `[source,ordinal,"mode","oid",nameAt,nameLength,cumulativeBase]` */
  #entryJsonLength(row: number, source: number, nameAt: number, nameLength: number): number {
    return (
      digitCount(source) +
      digitCount(this.#ordinal[row]!) +
      MODE_BYTES[this.#mode[row]!]!.length +
      OID_HEX_BYTES +
      digitCount(nameAt) +
      digitCount(nameLength) +
      digitCount(this.#cumulative[row]!) +
      ENTRY_ROW_PUNCTUATION
    );
  }

  #writeEntryJson(
    bytes: Uint8Array,
    start: number,
    row: number,
    source: number,
    nameAt: number,
    nameLength: number,
  ): number {
    let at = start;
    bytes[at++] = 0x5b;
    at = writeInteger(bytes, at, source);
    bytes[at++] = 0x2c;
    at = writeInteger(bytes, at, this.#ordinal[row]!);
    bytes[at++] = 0x2c;
    bytes[at++] = 0x22;
    const mode = MODE_BYTES[this.#mode[row]!]!;
    bytes.set(mode, at);
    at += mode.length;
    bytes[at++] = 0x22;
    bytes[at++] = 0x2c;
    bytes[at++] = 0x22;
    const oidAt = row * OID_BYTES;
    for (let byte = oidAt; byte < oidAt + OID_BYTES; byte++) {
      const value = this.#oid[byte]!;
      bytes[at++] = HEX_DIGITS[value >> 4]!;
      bytes[at++] = HEX_DIGITS[value & 15]!;
    }
    bytes[at++] = 0x22;
    bytes[at++] = 0x2c;
    at = writeInteger(bytes, at, nameAt);
    bytes[at++] = 0x2c;
    at = writeInteger(bytes, at, nameLength);
    bytes[at++] = 0x2c;
    at = writeInteger(bytes, at, this.#cumulative[row]!);
    bytes[at++] = 0x5d;
    return at;
  }
}

/**
 * The fixed-size buffers one owner reuses across batches: a pack ingest's
 * `PackTreeIndex`, or a loose batch that allocates its own. One batch borrows
 * them at a time and resets them when it is disposed.
 */
export class TreeIndexBuffers {
  readonly rows: TreeIndexRows;
  readonly entryWindow = new Uint8Array(TREE_INDEX_ENTRY_ARENA_BYTES);
  readonly markerWindow = new Uint8Array(TREE_INDEX_MARKER_ARENA_BYTES);
  #borrowed = false;

  constructor(rowCapacity: number, nameCapacity: number) {
    this.rows = new TreeIndexRows(rowCapacity, nameCapacity);
  }

  borrow(): void {
    if (this.#borrowed) throw new Error("tree index buffers are already in use");
    this.#borrowed = true;
  }

  release(): void {
    this.rows.reset();
    this.#borrowed = false;
  }
}
