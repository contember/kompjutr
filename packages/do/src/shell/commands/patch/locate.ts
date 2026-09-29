// Where a hunk applies.
//
// The first guess is the hunk's own line plus the offset the previous hunk
// needed. Each fuzz level then takes candidates outwards from that guess,
// nearest first and forward before backward at equal distance. Candidates
// come from the file's hash index for the hunk's rarest compared line, so a
// level costs a lookup plus one comparison run per real candidate.
//
// Fuzz ignores context at the hunk's edges. A hunk whose context is uneven
// was cut by the start or end of its file, so its short side counts as
// already fuzzed and a hunk still uneven after fuzzing must sit against that
// edge of the file: the start when its first line is 1, else the end.
//
// The previous hunk consumed the file up to `floor`, its trailing context
// excluded. As GNU does, a candidate before the guess must start at `floor`;
// one whose first changed line falls before `floor` is misordered; and one
// whose first compared line lies before the previous hunk's last consumed
// line is passed over.

import type { RetainedBudget } from "../../exec/context.js";
import { type FileLines, hashLine } from "./file-lines.js";
import { CONTEXT, type Hunk, REMOVED } from "./hunk.js";

/** The old side of a hunk, prepared for searching; thirteen bytes a line, reserved. */
export class Pattern {
  readonly length: number;
  readonly prefix: number;
  readonly suffix: number;
  readonly context: number;
  readonly hashes: Uint32Array;
  readonly #source: Uint8Array;
  readonly #starts: Uint32Array;
  readonly #lengths: Uint32Array;
  readonly #newlines: Uint8Array;
  readonly #release: () => void;

  constructor(
    readonly hunk: Hunk,
    budget: RetainedBudget,
  ) {
    let length = 0;
    for (let index = 0; index < hunk.count; index++) if (isOld(hunk, index)) length++;
    this.#release = budget.retain(length * 13, "patch hunk");
    this.hashes = new Uint32Array(length);
    this.#starts = new Uint32Array(length);
    this.#lengths = new Uint32Array(length);
    this.#newlines = new Uint8Array(length);
    const source = hunk.source;
    let old = 0;
    for (let index = 0; index < hunk.count; index++) {
      if (!isOld(hunk, index)) continue;
      const bytes = hunk.bytes(index);
      const newline = hunk.newline(index);
      this.hashes[old] = hashLine(bytes, 0, bytes.length, newline);
      this.#starts[old] = bytes.byteOffset - source.byteOffset;
      this.#lengths[old] = bytes.length;
      this.#newlines[old] = newline ? 1 : 0;
      old++;
    }
    this.#source = source;
    this.length = length;
    let prefix = 0;
    while (prefix < hunk.count && hunk.kind(prefix) === CONTEXT) prefix++;
    let suffix = 0;
    while (suffix < hunk.count - prefix && hunk.kind(hunk.count - 1 - suffix) === CONTEXT) {
      suffix++;
    }
    this.prefix = prefix;
    this.suffix = suffix;
    this.context = Math.max(prefix, suffix);
  }

  release(): void {
    this.#release();
  }

  hash(old: number): number {
    return this.hashes[old] ?? 0;
  }

  /** Byte comparison of old line `old` with file line `line`, once their hashes agree. */
  bytesMatch(file: FileLines, line: number, old: number): boolean {
    return file.equals(
      line,
      this.#source,
      this.#starts[old] ?? 0,
      this.#lengths[old] ?? 0,
      this.#newlines[old] === 1,
    );
  }

  /** Whether the first old line ends in CR, for GNU's "different line endings" note. */
  firstEndsWithCr(): boolean {
    const length = this.#lengths[0] ?? 0;
    if (this.length === 0 || length === 0) return false;
    return this.#source[(this.#starts[0] ?? 0) + length - 1] === 0x0d;
  }
}

function isOld(hunk: Hunk, index: number): boolean {
  return hunk.kind(index) === CONTEXT || hunk.kind(index) === REMOVED;
}

export type Found =
  | { readonly kind: "placed"; readonly at: number; readonly fuzz: number }
  | { readonly kind: "misordered"; readonly at: number };

interface Level {
  readonly fuzz: number;
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
    fuzz,
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
  if (rules.anchorStart && at !== 0) return false;
  if (rules.anchorEnd && at + pattern.length !== file.count) return false;
  const end = pattern.length - rules.skipSuffix;
  // Hashes first: a mismatch costs two array reads and no byte access.
  const fileHashes = file.hashes;
  const hunkHashes = pattern.hashes;
  for (let old = rules.skipPrefix; old < end; old++) {
    const line = at + old;
    if (line >= file.count || fileHashes[line] !== hunkHashes[old]) return false;
  }
  for (let old = rules.skipPrefix; old < end; old++) {
    if (!pattern.bytesMatch(file, at + old, old)) return false;
  }
  return true;
}

type Verdict = Found | "skip";

function judge(pattern: Pattern, at: number, rules: Level, floor: number): Verdict {
  if (at + pattern.prefix < floor) return { kind: "misordered", at };
  if (at + rules.skipPrefix < floor - 1) return "skip";
  return { kind: "placed", at, fuzz: rules.fuzz };
}

/**
 * The exact first guess, tried before any bounds apply: a hunk with no old
 * lines fits anywhere, even past the end of a short file.
 */
export function atGuess(
  file: FileLines,
  pattern: Pattern,
  guess: number,
  floor: number,
): Found | null {
  const rules = level(pattern, 0);
  if (!fits(file, pattern, guess, rules)) return null;
  const verdict = judge(pattern, guess, rules, floor);
  return verdict === "skip" ? null : verdict;
}

/** Scan one fuzz level outwards from the guess. */
export function search(
  file: FileLines,
  pattern: Pattern,
  guess: number,
  floor: number,
  fuzz: number,
): Found | null {
  const rules = level(pattern, fuzz);
  const last = file.count - (pattern.length - rules.skipSuffix);
  const lowest = Math.max(floor, 0);
  const allowed = (at: number): boolean => at >= 0 && at <= last && (at >= guess || at >= lowest);
  const decide = (at: number): Found | null | "next" => {
    if (!allowed(at) || !fits(file, pattern, at, rules)) return "next";
    const verdict = judge(pattern, at, rules, floor);
    return verdict === "skip" ? "next" : verdict;
  };

  if (rules.anchorStart || rules.anchorEnd) {
    const found = decide(rules.anchorStart ? 0 : file.count - pattern.length);
    return found === "next" ? null : found;
  }

  const first = rules.skipPrefix;
  const end = pattern.length - rules.skipSuffix;
  if (first >= end) return nearest(guess, lowest, last, (at) => decide(at));

  let probe = first;
  let fewest = Number.POSITIVE_INFINITY;
  for (let old = first; old < end; old++) {
    const count = file.occurrences(pattern.hash(old));
    if (count === null) return nearest(guess, lowest, last, (at) => decide(at));
    if (count < fewest) {
      fewest = count;
      probe = old;
    }
  }
  if (fewest === 0) return null;
  const positions = file.positions(pattern.hash(probe));
  if (positions === null) return nearest(guess, lowest, last, (at) => decide(at));
  try {
    return nearestOf(positions.lines, probe, guess, (at) => decide(at));
  } finally {
    positions.release();
  }
}

/** Walk every start in [lowest, last] outwards from the guess. */
function nearest(
  guess: number,
  lowest: number,
  last: number,
  decide: (at: number) => Found | null | "next",
): Found | null {
  let forward = Math.max(guess, 0);
  let backward = Math.min(guess - 1, last);
  while (forward <= last || backward >= lowest) {
    const forwardDistance = forward <= last ? forward - guess : Number.POSITIVE_INFINITY;
    const backwardDistance = backward >= lowest ? guess - backward : Number.POSITIVE_INFINITY;
    const at = forwardDistance <= backwardDistance ? forward++ : backward--;
    const found = decide(at);
    if (found !== "next") return found;
  }
  return null;
}

/** Walk the starts implied by `lines` (ascending) outwards from the guess. */
function nearestOf(
  lines: Uint32Array,
  probe: number,
  guess: number,
  decide: (at: number) => Found | null | "next",
): Found | null {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((lines[middle] ?? 0) - probe < guess) low = middle + 1;
    else high = middle;
  }
  let forward = low;
  let backward = low - 1;
  while (forward < lines.length || backward >= 0) {
    const ahead = forward < lines.length ? (lines[forward] ?? 0) - probe : null;
    const behind = backward >= 0 ? (lines[backward] ?? 0) - probe : null;
    let at: number;
    if (ahead !== null && (behind === null || ahead - guess <= guess - behind)) {
      at = ahead;
      forward++;
    } else if (behind !== null) {
      at = behind;
      backward--;
    } else {
      break;
    }
    const found = decide(at);
    if (found !== "next") return found;
  }
  return null;
}
