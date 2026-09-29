// A file's lines, hashed once, with an index from hash to line built the
// first time a hunk has to be searched for. The search probes only lines
// holding the rarest line of the hunk, so a hunk that cannot match costs a
// lookup, not a scan.

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

  constructor(
    readonly bytes: Uint8Array,
    private readonly budget: RetainedBudget,
    private readonly label: string,
  ) {
    this.#index = lineStarts(bytes, budget, label);
    this.count = this.#index.count;
    this.#starts = this.#index.starts;
    this.#releases.push(budget.retain(this.count * 4, label));
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

  /** Whether file line `line` equals `expected`, whose hash is `hash`. */
  matches(line: number, expected: Uint8Array, newline: boolean, hash: number): boolean {
    if (line < 0 || line >= this.count || this.#hashes[line] !== hash) return false;
    const start = this.start(line);
    const end = this.start(line + 1) - (this.newline(line) ? 1 : 0);
    if (this.newline(line) !== newline || end - start !== expected.length) return false;
    for (let index = 0; index < expected.length; index++) {
      if (this.bytes[start + index] !== expected[index]) return false;
    }
    return true;
  }

  firstEndsWithCr(): boolean {
    if (this.count === 0) return false;
    const end = this.start(1) - (this.newline(0) ? 1 : 0);
    return end > this.start(0) && this.bytes[end - 1] === 0x0d;
  }

  /** An upper bound on how many lines have this hash. */
  occurrences(hash: number): number {
    return this.#bucketIndex().count(hash);
  }

  /** Lines with this hash, ascending; reserved while the caller holds them. */
  positions(hash: number): { readonly lines: Uint32Array; release(): void } {
    const buckets = this.#bucketIndex();
    const release = this.budget.retain(buckets.count(hash) * 4, this.label);
    return { lines: buckets.lines(hash, this.#hashes), release };
  }

  #bucketIndex(): HashBuckets {
    if (this.#buckets === null) {
      let size = MIN_BUCKETS;
      while (size < this.count) size *= 2;
      this.#releases.push(this.budget.retain(size * 8 + this.count * 4, this.label));
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
