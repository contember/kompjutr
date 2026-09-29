// A file's lines, hashed once, with an index from hash to line built the
// first time a hunk has to be searched for. The search probes only lines
// holding the rarest line of the hunk, so a hunk that cannot match costs a
// lookup, not a scan. When the index would not fit the retained budget the
// search scans instead, comparing hashes before bytes.

import type { RetainedBudget } from "../../exec/context.js";
import { type LineIndex, lineStarts } from "./text.js";

const NEWLINE = 0x0a;
const MIN_BUCKETS = 16;

export class FileLines {
  readonly count: number;
  readonly #starts: Uint32Array;
  readonly #hashes: Uint32Array;
  readonly #index: LineIndex;
  readonly #releases: Array<() => void> = [];
  #buckets: HashBuckets | null = null;
  #indexRefused = false;

  constructor(
    readonly bytes: Uint8Array,
    private readonly budget: RetainedBudget,
    private readonly label: string,
  ) {
    this.#index = lineStarts(bytes, budget, label);
    this.count = this.#index.count;
    this.#starts = this.#index.starts;
    try {
      this.#releases.push(budget.retain(this.count * 4, label));
    } catch (error) {
      this.#index.release();
      throw error;
    }
    this.#hashes = new Uint32Array(this.count);
    for (let line = 0; line < this.count; line++) {
      const start = this.#starts[line] ?? 0;
      const end = this.#starts[line + 1] ?? 0;
      const newline = end > start && bytes[end - 1] === NEWLINE;
      this.#hashes[line] = hashLine(bytes, start, newline ? end - 1 : end, newline);
    }
  }

  release(): void {
    this.#index.release();
    for (const release of this.#releases) release();
    this.#releases.length = 0;
  }

  /** Byte offset where a line starts; `count` gives the end of the file. */
  start(line: number): number {
    return this.#starts[Math.min(line, this.count)] ?? this.bytes.length;
  }

  newline(line: number): boolean {
    const end = this.start(line + 1);
    return end > this.start(line) && this.bytes[end - 1] === NEWLINE;
  }

  /** Each line's hash, for comparing before touching bytes. */
  get hashes(): Uint32Array {
    return this.#hashes;
  }

  /** Whether file line `line` holds exactly `length` bytes of `source` at `start`. */
  equals(
    line: number,
    source: Uint8Array,
    start: number,
    length: number,
    newline: boolean,
  ): boolean {
    const from = this.start(line);
    const end = this.start(line + 1) - (this.newline(line) ? 1 : 0);
    if (this.newline(line) !== newline || end - from !== length) return false;
    for (let index = 0; index < length; index++) {
      if (this.bytes[from + index] !== source[start + index]) return false;
    }
    return true;
  }

  firstEndsWithCr(): boolean {
    if (this.count === 0) return false;
    const end = this.start(1) - (this.newline(0) ? 1 : 0);
    return end > this.start(0) && this.bytes[end - 1] === 0x0d;
  }

  /**
   * An upper bound on how many lines have this hash, or null when the index
   * does not fit the retained budget and the caller must scan instead.
   */
  occurrences(hash: number): number | null {
    return this.#bucketIndex()?.count(hash) ?? null;
  }

  /** Lines with this hash, ascending, or null when they do not fit the budget. */
  positions(hash: number): { readonly lines: Uint32Array; release(): void } | null {
    const buckets = this.#bucketIndex();
    if (buckets === null) return null;
    const bytes = buckets.count(hash) * 4;
    if (bytes > this.budget.available) return null;
    const release = this.budget.retain(bytes, this.label);
    return { lines: buckets.lines(hash, this.#hashes), release };
  }

  // The index is an accelerator, so it is built only when it fits comfortably
  // within what the budget has left; otherwise hunks are found by scanning.
  #bucketIndex(): HashBuckets | null {
    if (this.#buckets === null && !this.#indexRefused) {
      let size = MIN_BUCKETS;
      while (size < this.count) size *= 2;
      const bytes = size * 8 + this.count * 4;
      if (bytes * 2 > this.budget.available) {
        this.#indexRefused = true;
        return null;
      }
      this.#releases.push(this.budget.retain(bytes, this.label));
      this.#buckets = new HashBuckets(this.#hashes, size);
    }
    return this.#buckets;
  }
}

/** Chains of lines per hash bucket, each chain ascending. */
class HashBuckets {
  readonly #head: Int32Array;
  readonly #sizes: Uint32Array;
  readonly #next: Int32Array;
  readonly #mask: number;

  constructor(hashes: Uint32Array, size: number) {
    this.#mask = size - 1;
    this.#head = new Int32Array(size).fill(-1);
    this.#sizes = new Uint32Array(size);
    this.#next = new Int32Array(hashes.length);
    for (let line = hashes.length - 1; line >= 0; line--) {
      const bucket = (hashes[line] ?? 0) & this.#mask;
      this.#next[line] = this.#head[bucket] ?? -1;
      this.#head[bucket] = line;
      this.#sizes[bucket] = (this.#sizes[bucket] ?? 0) + 1;
    }
  }

  count(hash: number): number {
    return this.#sizes[hash & this.#mask] ?? 0;
  }

  lines(hash: number, hashes: Uint32Array): Uint32Array {
    const out = new Uint32Array(this.count(hash));
    let used = 0;
    for (
      let line = this.#head[hash & this.#mask] ?? -1;
      line !== -1;
      line = this.#next[line] ?? -1
    ) {
      if (hashes[line] === hash) out[used++] = line;
    }
    return out.subarray(0, used);
  }
}

/** FNV-1a over the bytes, with the newline folded in, so unequal hashes prove unequal lines. */
export function hashLine(bytes: Uint8Array, start: number, end: number, newline: boolean): number {
  let hash = newline ? 0x811c9dc5 : 0x050c5d1f;
  for (let index = start; index < end; index++) {
    hash ^= bytes[index] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
