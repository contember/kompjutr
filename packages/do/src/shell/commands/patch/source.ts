// The patch input, read line by line as GNU patch reads it. Lines starting
// with `#` are comments; a final line without a newline ends the input with
// a notice; a patch's indentation and RFC 934 `- ` prefixes are stripped.
// GNU seeks back to re-read a line that ended one patch as the start of the
// next, and the line numbers in its messages follow those re-reads.

import { joinBytes, PatchFatal } from "./messages.js";

export interface LineStyle {
  /** Columns of leading blanks (` `, `X`, or tab) to strip. */
  readonly indent: number;
  /** Leading `- ` pairs to strip. */
  readonly nesting: number;
  readonly stripCr: boolean;
  readonly allowNul: boolean;
}

export const PLAIN: LineStyle = { indent: 0, nesting: 0, stripCr: false, allowNul: false };

const TAB = 0x09;
const NEWLINE = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const HASH = 0x23;
const DASH = 0x2d;
const X = 0x58;
const BACKSLASH = 0x5c;

export class PatchSource {
  position = 0;
  /** The number of the last line read. */
  line = 0;
  /** Where the next search for a patch header starts (GNU's `p_base`). */
  base = 0;
  baseLine = 1;
  /** The line where the last header search stopped (GNU's `p_sline`). */
  patchLine = 0;

  constructor(
    readonly bytes: Uint8Array,
    private readonly say: (text: string) => void,
  ) {}

  get size(): number {
    return this.bytes.length;
  }

  seek(position: number, line: number): void {
    this.position = position;
    this.line = line - 1;
  }

  /** Remember where the next patch search starts. */
  intuitAt(position: number, line: number): void {
    this.base = position;
    this.baseLine = line;
  }

  /** The next line including its newline, or null at the end of input. */
  read(style: LineStyle): Uint8Array | null {
    const bytes = this.bytes;
    let nesting = style.nesting;
    for (;;) {
      let invalid = false;
      let column = 0;
      let byte: number;
      for (;;) {
        const next = bytes[this.position];
        if (next === undefined) return null;
        this.position++;
        byte = next;
        if (style.indent <= column) break;
        if (byte === SPACE || byte === X) column++;
        else if (byte === TAB) column = (column + 8) & ~7;
        else invalid ||= !style.allowNul && byte === 0;
      }

      let start = this.position - 1;
      while (byte === DASH && 0 <= --nesting) {
        const next = bytes[this.position];
        if (next === undefined) return this.#endsMidLine();
        this.position++;
        if (next !== SPACE) {
          start = this.position - 2;
          byte = next;
          break;
        }
        const after = bytes[this.position];
        if (after === undefined) return this.#endsMidLine();
        this.position++;
        byte = after;
        start = this.position - 1;
      }

      while (byte !== NEWLINE) {
        invalid ||= !style.allowNul && byte === 0;
        const next = bytes[this.position];
        if (next === undefined) return this.#endsMidLine();
        this.position++;
        byte = next;
      }
      this.line++;
      const line = bytes.subarray(start, this.position);
      if (line[0] === HASH) continue;
      if (invalid) throw new PatchFatal(`patch line ${this.line} contains NUL byte`);
      if (style.stripCr && line.length >= 2 && line[line.length - 2] === CR) {
        return joinBytes(line.subarray(0, line.length - 2), "\n");
      }
      return line;
    }
  }

  /** Consume a `\ No newline at end of file` line if one comes next. */
  incompleteLine(): boolean {
    if (this.bytes[this.position] !== BACKSLASH) return false;
    const end = this.bytes.indexOf(NEWLINE, this.position);
    this.position = end === -1 ? this.bytes.length : end + 1;
    return true;
  }

  /** The raw lines between two positions, as GNU echoes skipped text. */
  *rawLines(from: number, to: number): Generator<Uint8Array, void, undefined> {
    let start = from;
    while (start < to) {
      const end = this.bytes.indexOf(NEWLINE, start);
      const stop = end === -1 ? this.bytes.length : end + 1;
      yield this.bytes.subarray(start, stop);
      start = stop;
    }
  }

  #endsMidLine(): null {
    this.say("patch unexpectedly ends in middle of line\n");
    return null;
  }
}
