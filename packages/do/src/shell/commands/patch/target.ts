// The file being patched, as GNU patch applies hunks to it: find where a
// hunk's old side matches, searching outward from the expected line and
// ignoring up to `fuzz` context lines at each end, then copy the input up
// to there and write the new side. Line numbers are one-based, as in GNU's
// messages; `lastFrozen` is the last input line already copied or dropped.

import type { Hunk, HunkLine } from "./hunk.js";

const NEWLINE = 0x0a;
const EMPTY = new Uint8Array(0);
const NEWLINE_BYTES = Uint8Array.of(NEWLINE);

export class Target {
  lastFrozen = 0;
  /** How far the matches so far sit from where the hunks said. */
  inOffset = 0;
  /** How far output line numbers have moved from input line numbers. */
  outOffset = 0;
  readonly output: Uint8Array[] = [];
  #afterNewline = true;
  #zeroOutput = true;

  constructor(private readonly lines: readonly Uint8Array[]) {}

  /** No byte and no hunk line was written; an empty result may be removed. */
  get zeroOutput(): boolean {
    return this.#zeroOutput;
  }

  /** The line where the hunk's old side matches under `fuzz`, or 0. */
  locate(hunk: Hunk, fuzz: number): number {
    const firstGuess = hunk.first + this.inOffset;
    const patternLines = hunk.old.length;
    const context = Math.max(hunk.prefixContext, hunk.suffixContext);
    let prefixFuzz = fuzz + hunk.prefixContext - context;
    const suffixFuzz = fuzz + hunk.suffixContext - context;
    const maxWhere = this.lines.length - (patternLines - suffixFuzz) + 1;
    const minWhere = this.lastFrozen + 1;
    const maxPositive = maxWhere - firstGuess;
    let maxNegative = firstGuess - minWhere;
    const maxOffset = Math.max(maxPositive, maxNegative);

    if (patternLines === 0) return firstGuess;
    if (firstGuess <= maxNegative) maxNegative = firstGuess - 1;

    if (prefixFuzz < 0 && hunk.first <= 1) {
      // The hunk can only match at the start of the file.
      if (
        suffixFuzz < 0 &&
        (patternLines !== this.lines.length || hunk.prefixContext < this.lastFrozen)
      ) {
        return 0;
      }
      const offset = 1 - firstGuess;
      if (
        this.lastFrozen <= hunk.prefixContext &&
        offset <= maxPositive &&
        this.#matches(hunk, firstGuess + offset, 0, suffixFuzz)
      ) {
        this.inOffset += offset;
        return firstGuess + offset;
      }
      return 0;
    }
    if (prefixFuzz < 0) prefixFuzz = 0;

    if (suffixFuzz < 0) {
      // The hunk can only match at the end of the file.
      const offset = firstGuess - (this.lines.length - patternLines + 1);
      if (offset <= maxNegative && this.#matches(hunk, firstGuess - offset, prefixFuzz, 0)) {
        this.inOffset -= offset;
        return firstGuess - offset;
      }
      return 0;
    }

    const minOffset =
      maxPositive < 0 ? firstGuess - maxWhere : maxNegative < 0 ? firstGuess - minWhere : 0;
    for (let offset = minOffset; offset <= maxOffset; offset++) {
      if (
        offset <= maxPositive &&
        this.#matches(hunk, firstGuess + offset, prefixFuzz, suffixFuzz)
      ) {
        this.inOffset += offset;
        return firstGuess + offset;
      }
      if (
        offset <= maxNegative &&
        this.#matches(hunk, firstGuess - offset, prefixFuzz, suffixFuzz)
      ) {
        this.inOffset -= offset;
        return firstGuess - offset;
      }
    }
    return 0;
  }

  #matches(hunk: Hunk, where: number, prefixFuzz: number, suffixFuzz: number): boolean {
    const last = hunk.old.length - suffixFuzz;
    for (let line = 1 + prefixFuzz; line <= last; line++) {
      const pattern = hunk.old[line - 1]?.bytes ?? EMPTY;
      if (!sameBytes(this.#input(line - 1 + where), pattern)) return false;
    }
    return true;
  }

  /** Whether the first hunk line and the input line at `where` disagree on CRLF. */
  lineEndingsDiffer(hunk: Hunk, where: number): boolean {
    const first = hunk.old[0]?.bytes ?? EMPTY;
    if (first.length === 0 || this.lines.length === 0) return false;
    const input = this.#input(Math.min(where, this.lines.length));
    if (input.length === 0) return false;
    return crlf(first) !== crlf(input);
  }

  /** Write the hunk at `where`. False when it lands before text already written. */
  apply(hunk: Hunk, where: number, say: (text: string) => void): boolean {
    const base = where - 1;
    let old = 0;
    let added = 0;
    while (old < hunk.old.length) {
      const oldLine = hunk.old[old];
      const newLine = hunk.added[added];
      if (oldLine?.kind === "-") {
        if (!this.#copyTill(base + old, say)) return false;
        this.lastFrozen++;
        old++;
      } else if (newLine === undefined) {
        break;
      } else if (newLine.kind === "+") {
        if (!this.#copyTill(base + old, say)) return false;
        this.#writeLine(newLine);
        added++;
      } else {
        old++;
        added++;
      }
    }
    if (hunk.added[added]?.kind === "+") {
      if (!this.#copyTill(base + old, say)) return false;
      for (let line = hunk.added[added]; line?.kind === "+"; line = hunk.added[++added]) {
        this.#writeLine(line);
      }
    }
    this.outOffset += hunk.added.length - hunk.old.length;
    return true;
  }

  /** Copy the rest of the input. */
  finish(say: (text: string) => void): boolean {
    return this.lastFrozen >= this.lines.length || this.#copyTill(this.lines.length, say);
  }

  #copyTill(last: number, say: (text: string) => void): boolean {
    if (this.lastFrozen > last) {
      say("misordered hunks! output would be garbled\n");
      return false;
    }
    while (this.lastFrozen < last) {
      const line = this.#input(++this.lastFrozen);
      if (line.length > 0) this.#write(line);
    }
    return true;
  }

  #writeLine(line: HunkLine): void {
    this.#zeroOutput = false;
    if (line.bytes.length === 0) this.#afterNewline = false;
    else this.#write(line.bytes);
  }

  #write(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    // A line written after an incomplete one first completes it.
    if (!this.#afterNewline) this.output.push(NEWLINE_BYTES);
    this.output.push(bytes);
    this.#afterNewline = bytes[bytes.length - 1] === NEWLINE;
    this.#zeroOutput = false;
  }

  #input(line: number): Uint8Array {
    return line >= 1 && line <= this.lines.length ? (this.lines[line - 1] ?? EMPTY) : EMPTY;
  }
}

/** Input lines, each with its newline; the last may lack one. */
export function splitLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== NEWLINE) continue;
    lines.push(bytes.subarray(start, index + 1));
    start = index + 1;
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function crlf(line: Uint8Array): boolean {
  return line.length >= 2 && line[line.length - 2] === 0x0d && line[line.length - 1] === NEWLINE;
}
