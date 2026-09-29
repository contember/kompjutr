// Where a hunk applies.
//
// The first guess is the hunk's own line plus the offset the previous hunk
// needed. Each fuzz level then scans outwards from that guess, nearest
// candidate first and forward before backward at equal distance, in one pass
// over the candidates, so a level costs at most one comparison run per line
// of the file. Lines are compared by a precomputed hash first.
//
// Fuzz ignores context at the hunk's edges. A hunk whose context is uneven
// was cut by the start or end of its file, so its short side counts as
// already fuzzed and a hunk still uneven after fuzzing must sit against that
// edge of the file: the start when its first line is 1, else the end.

import type { RetainedBudget } from "../../exec/context.js";
import type { Hunk } from "./hunk.js";
import { hashLine, type Line, type LineIndex, lineStarts } from "./text.js";

const NEWLINE = 0x0a;

/** A file's lines with a hash per line. */
export class FileLines {
  readonly count: number;
  readonly #starts: Uint32Array;
  readonly #hashes: Uint32Array;
  readonly #index: LineIndex;
  readonly #releaseHashes: () => void;

  constructor(
    readonly bytes: Uint8Array,
    budget: RetainedBudget,
    label: string,
  ) {
    this.#index = lineStarts(bytes, budget, label);
    this.count = this.#index.count;
    this.#starts = this.#index.starts;
    this.#releaseHashes = budget.retain(this.count * 4, label);
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
    this.#releaseHashes();
  }

  /** Byte offset where a line starts; `count` gives the end of the file. */
  start(line: number): number {
    return this.#starts[Math.min(line, this.count)] ?? this.bytes.length;
  }

  newline(line: number): boolean {
    const end = this.start(line + 1);
    return end > this.start(line) && this.bytes[end - 1] === NEWLINE;
  }

  matches(line: number, expected: Line, hash: number): boolean {
    if (line >= this.count || this.#hashes[line] !== hash) return false;
    const start = this.start(line);
    const end = this.start(line + 1) - (this.newline(line) ? 1 : 0);
    if (this.newline(line) !== expected.newline || end - start !== expected.bytes.length) {
      return false;
    }
    for (let index = 0; index < expected.bytes.length; index++) {
      if (this.bytes[start + index] !== expected.bytes[index]) return false;
    }
    return true;
  }

  firstEndsWithCr(): boolean {
    if (this.count === 0) return false;
    const end = this.start(1) - (this.newline(0) ? 1 : 0);
    return end > this.start(0) && this.bytes[end - 1] === 0x0d;
  }
}

/** The old side of a hunk, prepared for searching. */
export class Pattern {
  readonly old: readonly Line[];
  readonly hashes: Uint32Array;
  readonly prefix: number;
  readonly suffix: number;
  readonly context: number;

  constructor(readonly hunk: Hunk) {
    const old: Line[] = [];
    for (const entry of hunk.lines) if (entry.kind !== "+") old.push(entry.line);
    this.old = old;
    this.hashes = Uint32Array.from(old, (line) =>
      hashLine(line.bytes, 0, line.bytes.length, line.newline),
    );
    let prefix = 0;
    while (hunk.lines[prefix]?.kind === " ") prefix++;
    let suffix = 0;
    while (
      suffix < hunk.lines.length - prefix &&
      hunk.lines[hunk.lines.length - 1 - suffix]?.kind === " "
    ) {
      suffix++;
    }
    this.prefix = prefix;
    this.suffix = suffix;
    this.context = Math.max(prefix, suffix);
  }
}

export interface Placement {
  /** Zero-based line where the hunk's first old line goes. */
  readonly at: number;
  readonly fuzz: number;
}

interface Level {
  readonly skipPrefix: number;
  readonly skipSuffix: number;
  readonly anchorStart: boolean;
  readonly anchorEnd: boolean;
}

function level(pattern: Pattern, fuzz: number): Level {
  const skipPrefix = Math.min(
    pattern.prefix,
    Math.max(0, fuzz - (pattern.context - pattern.prefix)),
  );
  const skipSuffix = Math.min(
    pattern.suffix,
    Math.max(0, fuzz - (pattern.context - pattern.suffix)),
  );
  const prefix = pattern.prefix - skipPrefix;
  const suffix = pattern.suffix - skipSuffix;
  return {
    skipPrefix,
    skipSuffix,
    anchorStart: prefix < suffix && pattern.hunk.oldFirst === 1,
    anchorEnd: prefix > suffix,
  };
}

/** The highest fuzz level that can differ from a lower one. */
export function usefulFuzz(pattern: Pattern, maxFuzz: number): number {
  return Math.min(maxFuzz, pattern.context);
}

function fits(file: FileLines, pattern: Pattern, at: number, rules: Level): boolean {
  if (at < 0) return false;
  const length = pattern.old.length;
  if (rules.anchorStart && at !== 0) return false;
  if (rules.anchorEnd && at + length !== file.count) return false;
  for (let index = rules.skipPrefix; index < length - rules.skipSuffix; index++) {
    const line = pattern.old[index];
    if (line === undefined || !file.matches(at + index, line, pattern.hashes[index] ?? 0)) {
      return false;
    }
  }
  return true;
}

/**
 * The exact first guess, tried before any bounds apply: a hunk with no old
 * lines fits anywhere, even past the end of a short file.
 */
export function atGuess(file: FileLines, pattern: Pattern, guess: number): Placement | null {
  return fits(file, pattern, guess, level(pattern, 0)) ? { at: guess, fuzz: 0 } : null;
}

/**
 * Scan one fuzz level. Candidates before the guess may not start before
 * `floor`, where the previous hunk's trailing context began; candidates after
 * it may, and the caller reports those as misordered.
 */
export function search(
  file: FileLines,
  pattern: Pattern,
  guess: number,
  floor: number,
  fuzz: number,
): Placement | null {
  const rules = level(pattern, fuzz);
  const last = file.count - (pattern.old.length - rules.skipSuffix);
  if (rules.anchorStart || rules.anchorEnd) {
    const at = rules.anchorStart ? 0 : file.count - pattern.old.length;
    const reachable = at >= guess ? at <= last : at >= floor && at <= last;
    return reachable && fits(file, pattern, at, rules) ? { at, fuzz } : null;
  }
  let forward = Math.max(guess, 0);
  let backward = Math.min(guess - 1, last);
  const lowest = Math.max(floor, 0);
  while (forward <= last || backward >= lowest) {
    const forwardDistance = forward <= last ? forward - guess : Number.POSITIVE_INFINITY;
    const backwardDistance = backward >= lowest ? guess - backward : Number.POSITIVE_INFINITY;
    if (forwardDistance <= backwardDistance) {
      if (fits(file, pattern, forward, rules)) return { at: forward, fuzz };
      forward++;
    } else {
      if (fits(file, pattern, backward, rules)) return { at: backward, fuzz };
      backward--;
    }
  }
  return null;
}
