// One unified hunk, read from its `@@` line.
//
// A hunk ends when both line counts are satisfied; a `\` line after the last
// line still belongs to it. Trailing context that a mailer chopped at the end
// of the input is restored as blank context when at most three new lines are
// missing, which is how GNU tolerates it; anything else is a fatal error that
// names the offending line.

import type { Report } from "./report.js";
import { PatchFatalError } from "./report.js";
import { type Line, lineText, type PatchText, startsWith } from "./text.js";

export type HunkLineKind = " " | "-" | "+";

export interface HunkLine {
  readonly kind: HunkLineKind;
  readonly line: Line;
}

export interface Hunk {
  /** One-based first old line; for an empty range, the line it precedes. */
  readonly oldFirst: number;
  readonly oldCount: number;
  readonly newFirst: number;
  readonly newCount: number;
  /** Everything after the closing `@@`, kept for the reject file. */
  readonly heading: Uint8Array;
  readonly lines: readonly HunkLine[];
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

export function readHunk(text: PatchText, at: number, report: Report): ParsedHunk {
  const header = text.line(at);
  if (header === null) throw new PatchFatalError("unexpected end of file in patch");
  const range = parseRange(header, at + 1);
  const lines: HunkLine[] = [];
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
      const blank: Line = { bytes: new Uint8Array(), newline: true };
      while (remainingOld > 0 || remainingNew > 0) {
        if (remainingOld === 0 || remainingNew === 0) {
          malformed({ bytes: new Uint8Array([0x20]), newline: true }, last + 1);
        }
        lines.push({ kind: " ", line: blank });
        remainingOld--;
        remainingNew--;
      }
      break;
    }
    if (!line.newline) report.always("patch unexpectedly ends in middle of line\n");
    last = index;
    index++;
    const first = line.bytes[0];
    const body: Line = { bytes: line.bytes.subarray(1), newline: line.newline };
    if (line.bytes.length === 0 || first === 0x20) {
      if (remainingOld === 0 || remainingNew === 0) malformed(line, last + 1);
      lines.push({ kind: " ", line: line.bytes.length === 0 ? line : body });
      remainingOld--;
      remainingNew--;
    } else if (first === 0x2d) {
      if (remainingOld === 0) malformed(line, last + 1);
      lines.push({ kind: "-", line: body });
      remainingOld--;
    } else if (first === 0x2b) {
      if (remainingNew === 0) malformed(line, last + 1);
      lines.push({ kind: "+", line: body });
      remainingNew--;
    } else if (first === 0x5c && lines.length > 0) {
      dropNewline(lines);
    } else {
      malformed(line, last + 1);
    }
  }

  const trailer = text.line(index);
  if (trailer !== null && trailer.bytes[0] === 0x5c && lines.length > 0) {
    if (!trailer.newline) report.always("patch unexpectedly ends in middle of line\n");
    dropNewline(lines);
    index++;
  }
  return { hunk: { ...range, lines }, next: index };
}

function dropNewline(lines: HunkLine[]): void {
  const previous = lines.pop();
  if (previous === undefined) return;
  lines.push({ kind: previous.kind, line: { bytes: previous.line.bytes, newline: false } });
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
    heading: bytes.slice(cursor),
  };
}

/** The same hunk with old and new swapped, as `-R` reads it. */
export function reversed(hunk: Hunk): Hunk {
  return {
    oldFirst: hunk.newFirst,
    oldCount: hunk.newCount,
    newFirst: hunk.oldFirst,
    newCount: hunk.oldCount,
    heading: hunk.heading,
    lines: hunk.lines.map((entry) => ({
      kind: entry.kind === "-" ? "+" : entry.kind === "+" ? "-" : " ",
      line: entry.line,
    })),
  };
}
