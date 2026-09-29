// One unified hunk, read from its `@@` line.
//
// A hunk ends when both line counts are satisfied; a `\` line after the last
// line still belongs to it. Trailing context that a mailer chopped at the end
// of the input is restored as blank context when at most three new lines are
// missing, which is how GNU tolerates it; anything else is a fatal error that
// names the offending line.

import type { RetainedBudget } from "../../exec/context.js";
import type { Report } from "./report.js";
import { PatchFatalError } from "./report.js";
import { LineRows, Rows } from "./store.js";
import { type Line, lineText, type PatchText, startsWith } from "./text.js";

export const CONTEXT = 0;
export const REMOVED = 1;
export const ADDED = 2;
export type HunkLineKind = typeof CONTEXT | typeof REMOVED | typeof ADDED;

const OLD_FIRST = 0;
const OLD_COUNT = 1;
const NEW_FIRST = 2;
const NEW_COUNT = 3;
const FIRST_LINE = 4;
const LINE_COUNT = 5;
const HEADING_START = 6;
const HEADING_LENGTH = 7;
const HUNK_FIELDS = 8;

/** Every hunk of one file patch, as rows over the held diff. */
export class HunkStore {
  readonly lines: LineRows;
  readonly hunks: Rows;

  constructor(
    readonly source: Uint8Array,
    budget: RetainedBudget,
  ) {
    this.lines = new LineRows(budget);
    this.hunks = new Rows(HUNK_FIELDS, budget, "patch hunks");
  }

  /** Forget the last hunk read, for hunks that are only counted. */
  dropLast(): void {
    const last = this.hunks.count - 1;
    if (last < 0) return;
    this.lines.truncate(this.hunks.get(last, FIRST_LINE));
    this.hunks.truncate(last);
  }

  release(): void {
    this.lines.release();
    this.hunks.release();
  }
}

/** A view of one stored hunk; a reversed view swaps removals with additions. */
export class Hunk {
  constructor(
    private readonly store: HunkStore,
    readonly index: number,
    readonly swapped: boolean,
  ) {}

  /** One-based first old line; for an empty range, the line it precedes. */
  get oldFirst(): number {
    return this.store.hunks.get(this.index, this.swapped ? NEW_FIRST : OLD_FIRST);
  }

  get oldCount(): number {
    return this.store.hunks.get(this.index, this.swapped ? NEW_COUNT : OLD_COUNT);
  }

  get newFirst(): number {
    return this.store.hunks.get(this.index, this.swapped ? OLD_FIRST : NEW_FIRST);
  }

  get newCount(): number {
    return this.store.hunks.get(this.index, this.swapped ? OLD_COUNT : NEW_COUNT);
  }

  get count(): number {
    return this.store.hunks.get(this.index, LINE_COUNT);
  }

  /** Everything after the closing `@@`, kept for the reject file. */
  get heading(): Uint8Array {
    const start = this.store.hunks.get(this.index, HEADING_START);
    return this.store.source.subarray(
      start,
      start + this.store.hunks.get(this.index, HEADING_LENGTH),
    );
  }

  kind(index: number): HunkLineKind {
    const kind = this.store.lines.kind(this.#line(index));
    if (kind === REMOVED) return this.swapped ? ADDED : REMOVED;
    if (kind === ADDED) return this.swapped ? REMOVED : ADDED;
    return CONTEXT;
  }

  bytes(index: number): Uint8Array {
    const line = this.#line(index);
    const start = this.store.lines.start(line);
    return this.store.source.subarray(start, start + this.store.lines.length(line));
  }

  newline(index: number): boolean {
    return this.store.lines.newline(this.#line(index));
  }

  reversed(): Hunk {
    return new Hunk(this.store, this.index, !this.swapped);
  }

  #line(index: number): number {
    return this.store.hunks.get(this.index, FIRST_LINE) + index;
  }
}

export interface ParsedHunk {
  readonly hunk: Hunk;
  /** Index of the first line after the hunk. */
  readonly next: number;
}

const MISSING_NEWLINE_TOLERANCE = 3;

export function isHunkStart(line: Line | null): boolean {
  return line !== null && startsWith(line, "@@ -");
}

/** Read the hunk whose `@@` line is at `at` into the store. */
export function readHunk(
  text: PatchText,
  at: number,
  report: Report,
  store: HunkStore,
): ParsedHunk {
  const header = text.line(at);
  if (header === null) throw new PatchFatalError("unexpected end of file in patch");
  const range = parseRange(header, at + 1);
  const source = store.source;
  const offset = (bytes: Uint8Array): number => bytes.byteOffset - source.byteOffset;
  const lines = store.lines;
  const firstLine = lines.count;
  const row = store.hunks.push(
    range.oldFirst,
    range.oldCount,
    range.newFirst,
    range.newCount,
    firstLine,
    0,
    offset(range.heading),
    range.heading.length,
  );
  try {
    let remainingOld = range.oldCount;
    let remainingNew = range.newCount;
    let index = at + 1;
    let last = at;

    const malformed = (line: Line, number: number): never => {
      throw new PatchFatalError(
        `malformed patch at line ${number}: ${lineText(line)}${line.newline ? "\n" : ""}`,
      );
    };

    while (remainingOld > 0 || remainingNew > 0) {
      const line = text.line(index);
      if (line === null) {
        if (remainingNew > MISSING_NEWLINE_TOLERANCE) {
          throw new PatchFatalError("unexpected end of file in patch");
        }
        while (remainingOld > 0 || remainingNew > 0) {
          if (remainingOld === 0 || remainingNew === 0) {
            malformed({ bytes: new Uint8Array([0x20]), newline: true }, last + 1);
          }
          lines.push(CONTEXT, 0, 0, true);
          remainingOld--;
          remainingNew--;
        }
        break;
      }
      if (!line.newline) report.always("patch unexpectedly ends in middle of line\n");
      last = index;
      index++;
      const first = line.bytes[0];
      const bodyStart = offset(line.bytes) + 1;
      const bodyLength = line.bytes.length - 1;
      if (line.bytes.length === 0 || first === 0x20) {
        if (remainingOld === 0 || remainingNew === 0) malformed(line, last + 1);
        if (line.bytes.length === 0) lines.push(CONTEXT, offset(line.bytes), 0, line.newline);
        else lines.push(CONTEXT, bodyStart, bodyLength, line.newline);
        remainingOld--;
        remainingNew--;
      } else if (first === 0x2d) {
        if (remainingOld === 0) malformed(line, last + 1);
        lines.push(REMOVED, bodyStart, bodyLength, line.newline);
        remainingOld--;
      } else if (first === 0x2b) {
        if (remainingNew === 0) malformed(line, last + 1);
        lines.push(ADDED, bodyStart, bodyLength, line.newline);
        remainingNew--;
      } else if (first === 0x5c && lines.count > firstLine) {
        lines.dropLastNewline();
      } else {
        malformed(line, last + 1);
      }
    }

    const trailer = text.line(index);
    if (trailer !== null && trailer.bytes[0] === 0x5c && lines.count > firstLine) {
      if (!trailer.newline) report.always("patch unexpectedly ends in middle of line\n");
      lines.dropLastNewline();
      index++;
    }
    store.hunks.set(row, LINE_COUNT, lines.count - firstLine);
    return { hunk: new Hunk(store, row, false), next: index };
  } catch (error) {
    store.dropLast();
    throw error;
  }
}

interface Range {
  readonly oldFirst: number;
  readonly oldCount: number;
  readonly newFirst: number;
  readonly newCount: number;
  readonly heading: Uint8Array;
}

function parseRange(header: Line, number: number): Range {
  const bytes = header.bytes;
  const shown = `${lineText(header)}${header.newline ? "\n" : ""}`;
  let cursor = 4;
  const fail = (what: string): never => {
    throw new PatchFatalError(`${what} at line ${number}: ${shown}`);
  };
  const digits = (): number => {
    const start = cursor;
    while (cursor < bytes.length && (bytes[cursor] ?? 0) >= 0x30 && (bytes[cursor] ?? 0) <= 0x39) {
      cursor++;
    }
    if (cursor === start) fail("missing line number");
    const text = lineText({ bytes: bytes.subarray(start, cursor), newline: false });
    const value = Number(text);
    if (!Number.isSafeInteger(value)) fail(`line number ${text} is too large`);
    return value;
  };
  const optionalCount = (): number => {
    if (bytes[cursor] !== 0x2c) return 1;
    cursor++;
    return digits();
  };
  const skipSpaces = (): void => {
    while (bytes[cursor] === 0x20) cursor++;
  };

  const oldStart = digits();
  const oldCount = optionalCount();
  skipSpaces();
  if (bytes[cursor] !== 0x2b) fail("malformed patch");
  cursor++;
  const newStart = digits();
  const newCount = optionalCount();
  skipSpaces();
  if (bytes[cursor] !== 0x40 || bytes[cursor + 1] !== 0x40) fail("malformed patch");
  cursor += 2;
  return {
    oldFirst: oldCount === 0 ? oldStart + 1 : oldStart,
    oldCount,
    newFirst: newCount === 0 ? newStart + 1 : newStart,
    newCount,
    heading: bytes.subarray(
      cursor,
      bytes[bytes.length - 1] === 0x0d ? bytes.length - 1 : bytes.length,
    ),
  };
}
