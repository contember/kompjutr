// Lines of the diff and of the files it patches.
//
// A line is its bytes without the newline plus whether a newline ended it:
// a context line that lacks one does not match a file line that has one,
// which is how `\ No newline at end of file` takes effect. The diff is held
// once; a line index over it costs four bytes per line and is retained with
// it.

import type { RetainedBudget } from "../../exec/context.js";

export interface Line {
  readonly bytes: Uint8Array;
  readonly newline: boolean;
}

const NEWLINE = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const TAB_WIDTH = 8;

/** Offsets of every line start in `bytes`, plus the end. */
export function lineStarts(bytes: Uint8Array, budget: RetainedBudget, label: string): LineIndex {
  let count = 0;
  for (let index = 0; index < bytes.length; index++) if (bytes[index] === NEWLINE) count++;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE) count++;
  const release = budget.retain((count + 1) * 4, label);
  const starts = new Uint32Array(count + 1);
  let line = 1;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === NEWLINE && index + 1 < bytes.length) starts[line++] = index + 1;
  }
  starts[count] = bytes.length;
  return { starts, count, release };
}

export interface LineIndex {
  readonly starts: Uint32Array;
  readonly count: number;
  release(): void;
}

/** The diff input: raw lines by zero-based index. */
export class PatchInput {
  readonly count: number;
  readonly #starts: Uint32Array;

  constructor(
    readonly bytes: Uint8Array,
    index: LineIndex,
  ) {
    this.count = index.count;
    this.#starts = index.starts;
  }

  raw(line: number): Line | null {
    if (line < 0 || line >= this.count) return null;
    const start = this.#starts[line] ?? 0;
    const end = this.#starts[line + 1] ?? this.bytes.length;
    const newline = end > start && this.bytes[end - 1] === NEWLINE;
    return { bytes: this.bytes.subarray(start, newline ? end - 1 : end), newline };
  }
}

/**
 * One patch's view of the input. A diff indented by a consistent amount or
 * carrying CRLF line endings is read with both removed, as GNU does.
 */
export class PatchText {
  constructor(
    readonly input: PatchInput,
    readonly indent: number,
    readonly stripCr: boolean,
  ) {}

  line(index: number): Line | null {
    const raw = this.input.raw(index);
    if (raw === null) return null;
    return normalizeLine(raw, this.indent, this.stripCr);
  }
}

export function normalizeLine(line: Line, indent: number, stripCr: boolean): Line {
  let bytes = line.bytes;
  if (indent > 0) {
    let column = 0;
    let cursor = 0;
    while (cursor < bytes.length && column < indent) {
      const byte = bytes[cursor];
      if (byte === SPACE) column++;
      else if (byte === TAB) column = (Math.floor(column / TAB_WIDTH) + 1) * TAB_WIDTH;
      else break;
      cursor++;
    }
    bytes = bytes.subarray(cursor);
  }
  if (stripCr && bytes.length > 0 && bytes[bytes.length - 1] === CR) {
    bytes = bytes.subarray(0, bytes.length - 1);
  }
  return { bytes, newline: line.newline };
}

/** Columns of leading blanks, a tab advancing to the next multiple of eight. */
export function indentOf(bytes: Uint8Array): number {
  let column = 0;
  for (const byte of bytes) {
    if (byte === SPACE) column++;
    else if (byte === TAB) column = (Math.floor(column / TAB_WIDTH) + 1) * TAB_WIDTH;
    else break;
  }
  return column;
}

export function endsWithCr(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes[bytes.length - 1] === CR;
}

export function startsWith(line: Line, prefix: string): boolean {
  if (line.bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (line.bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

const DECODER = new TextDecoder();

export function lineText(line: Line): string {
  return DECODER.decode(line.bytes);
}

export function hasNul(line: Line): boolean {
  return line.bytes.includes(0);
}

export function sameLine(left: Line, right: Line): boolean {
  if (left.newline !== right.newline || left.bytes.length !== right.bytes.length) return false;
  for (let index = 0; index < left.bytes.length; index++) {
    if (left.bytes[index] !== right.bytes[index]) return false;
  }
  return true;
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
