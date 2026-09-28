// One unified hunk, read as GNU patch reads it. A line starting with a tab
// or an empty line is context whose leading space was eaten; `=` is context
// too. Near the end of input, missing trailing lines are taken to be blank
// context that got chopped. `\ No newline at end of file` drops the newline
// from the last line of whichever side it follows.

import { joinBytes, PatchFatal } from "./messages.js";
import { isBlank, isDigit } from "./names.js";
import type { LineStyle, PatchSource } from "./source.js";

export interface HunkLine {
  readonly kind: "-" | "+" | " ";
  /** The text with its newline, unless it is a file's incomplete last line. */
  readonly bytes: Uint8Array;
}

export class Hunk {
  constructor(
    /** First old line; for an empty old side, the line it follows plus one. */
    public first: number,
    public newFirst: number,
    public old: HunkLine[],
    public added: HunkLine[],
    readonly prefixContext: number,
    readonly suffixContext: number,
    /** The text after `@@`, starting with its space. */
    readonly heading: Uint8Array | null,
  ) {}

  /** Exchange the sides, as `-R` or an accepted reversal does. */
  swap(): void {
    const old = this.old;
    [this.first, this.newFirst] = [this.newFirst, this.first];
    this.old = this.added.map((line) =>
      line.kind === "+" ? { kind: "-", bytes: line.bytes } : line,
    );
    this.added = old.map((line) => (line.kind === "-" ? { kind: "+", bytes: line.bytes } : line));
  }
}

const BLANK_CONTEXT = new TextEncoder().encode(" \n");

/** The next hunk of the current patch, or null when the patch has no more. */
export function readHunk(source: PatchSource, style: LineStyle, reverse: boolean): Hunk | null {
  const lineStart = source.position;
  const header = source.read({ ...style, allowNul: false });
  if (header === null || header.length <= 4 || !startsWith(header, "@@ -")) {
    source.intuitAt(lineStart, source.line);
    return null;
  }
  const malformed = (text: Uint8Array): PatchFatal =>
    new PatchFatal(joinBytes(`malformed patch at line ${source.line}: `, text));

  let at = 4;
  const number = (): number => {
    while (isBlank(header[at])) at++;
    const from = at;
    let value = 0;
    while (isDigit(header[at])) value = value * 10 + ((header[at++] ?? 0) - 0x30);
    if (at === from) {
      throw new PatchFatal(joinBytes(`missing line number at line ${source.line}: `, header));
    }
    if (!Number.isSafeInteger(value)) {
      const digits = new TextDecoder().decode(header.subarray(from, at));
      throw new PatchFatal(
        joinBytes(`line number ${digits} is too large at line ${source.line}: `, header),
      );
    }
    while (isBlank(header[at])) at++;
    return value;
  };
  let first = number();
  let oldCount = 1;
  if (header[at] === 0x2c) {
    at++;
    oldCount = number();
  }
  if (header[at] === 0x20) at++;
  if (header[at] !== 0x2b) throw malformed(header);
  at++;
  let newFirst = number();
  let newCount = 1;
  if (header[at] === 0x2c) {
    at++;
    newCount = number();
  }
  if (header[at] === 0x20) at++;
  if (header[at++] !== 0x40) throw malformed(header);
  let heading: Uint8Array | null = null;
  if (header[at++] === 0x40 && header[at] === 0x20) {
    heading = header.subarray(at, header.length - 1);
  }
  if (oldCount === 0) first++;
  if (newCount === 0) newFirst++;

  const old: HunkLine[] = [];
  const added: HunkLine[] = [];
  let context = 0;
  let prefixContext = -1;
  let line: Uint8Array = header;
  while (old.length < oldCount || added.length < newCount) {
    line = source.read({ ...style, allowNul: true }) ?? BLANK_CONTEXT;
    if (line === BLANK_CONTEXT && newCount - 1 - added.length >= 3) {
      throw new PatchFatal("unexpected end of file in patch");
    }
    const eaten = line[0] === 0x09 || line[0] === 0x0a;
    let kind = eaten ? 0x20 : (line[0] ?? 0);
    let text = eaten ? line : line.subarray(1);
    if (kind === 0x3d) kind = 0x20;
    switch (kind) {
      case 0x2d:
        if (old.length >= oldCount) throw malformed(line);
        if (old.length === oldCount - 1 && source.incompleteLine()) text = chop(text);
        old.push({ kind: "-", bytes: text });
        break;
      case 0x20:
        if (old.length >= oldCount) throw malformed(line);
        context++;
        if (old.length === oldCount - 1 && source.incompleteLine()) text = chop(text);
        old.push({ kind: " ", bytes: text });
        if (added.length >= newCount) throw malformed(line);
        if (added.length === newCount - 1 && source.incompleteLine()) text = chop(text);
        added.push({ kind: " ", bytes: text });
        break;
      case 0x2b:
        if (added.length >= newCount) throw malformed(line);
        if (added.length === newCount - 1 && source.incompleteLine()) text = chop(text);
        added.push({ kind: "+", bytes: text });
        break;
      default:
        throw malformed(line);
    }
    if (kind !== 0x20) {
      if (prefixContext < 0) prefixContext = context;
      context = 0;
    }
  }
  if (prefixContext < 0) throw malformed(line);

  const hunk = new Hunk(first, newFirst, old, added, prefixContext, context, heading);
  if (reverse) hunk.swap();
  return hunk;
}

function chop(text: Uint8Array): Uint8Array {
  return text.subarray(0, Math.max(0, text.length - 1));
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}
