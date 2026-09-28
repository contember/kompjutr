// GNU patch's header search: scan from where the last patch ended, collect
// file names, git extended headers, and timestamps, and stop at the line
// that starts a hunk. Text before it is commentary. The diff kind is
// recognized the way GNU recognizes it, so a context, normal, or ed diff is
// named — and refused by the caller — rather than read as garbage.

import { decode } from "../../exec/bytes.js";
import {
  type Fetched,
  fetchName,
  isBlank,
  isDigit,
  isSpace,
  parseName,
  type Stamp,
} from "./names.js";
import { type PatchSource, PLAIN } from "./source.js";

export type DiffKind = "unified" | "context" | "normal" | "ed" | "binary";
/** 0: exists and is non-empty, 1: probably empty, 2: does not exist. */
export type Existence = 0 | 1 | 2;
export type Side = 0 | 1;

export interface Header {
  readonly kind: DiffKind;
  /** Old, new, and `Index:` names, `-p` already applied. */
  readonly names: [string | null, string | null, string | null];
  readonly timestr: [Uint8Array | null, Uint8Array | null];
  readonly stamps: [Stamp, Stamp];
  readonly existence: [Existence, Existence];
  /** Git modes; 0 when not given or not a regular file or symlink. */
  readonly modes: [number, number];
  readonly git: boolean;
  readonly rename: boolean;
  readonly copy: boolean;
  readonly indent: number;
  readonly nesting: number;
  readonly stripCr: boolean;
  /** Where the patch body starts, and that line's number. */
  readonly start: number;
  readonly startLine: number;
  readonly revision: string | null;
}

interface Scan {
  kind: DiffKind;
  names: [string | null, string | null, string | null];
  timestr: [Uint8Array | null, Uint8Array | null];
  stamps: [Stamp, Stamp];
  existence: [Existence, Existence];
  modes: [number, number];
  git: boolean;
  renames: [boolean, boolean];
  copies: [boolean, boolean];
  indent: number;
  nesting: number;
  stripCr: boolean;
  start: number;
  startLine: number;
  revision: string | null;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/** The next patch's header, or null when only trailing text remains. */
export function intuit(
  source: PatchSource,
  needHeader: boolean,
  strip: number,
  say: (text: string) => void,
): Header | null {
  const scan: Scan = {
    kind: "unified",
    names: [null, null, null],
    timestr: [null, null],
    stamps: ["none", "none"],
    existence: [0, 0],
    modes: [0, 0],
    git: false,
    renames: [false, false],
    copies: [false, false],
    indent: 0,
    nesting: 0,
    stripCr: false,
    start: 0,
    startLine: 0,
    revision: null,
  };
  let wantHeader = needHeader;
  let thisLine = 0;
  let firstCommand = -1;
  let firstCommandLine = 0;
  let firstEdLetter = false;
  let isCommand = false;
  let stars = false;
  let indent = 0;
  let extended = false;
  source.seek(source.base, source.baseLine);

  const found = (kind: DiffKind, start: number, line: number): Header => {
    scan.kind = kind;
    scan.start = start;
    scan.startLine = line;
    source.patchLine = line;
    return finish(scan);
  };

  for (;;) {
    const previousLine = thisLine;
    const lastWasCommand = isCommand;
    const starsLast = stars;
    const indentLast = indent;
    thisLine = source.position;
    const line = source.read(PLAIN);
    if (line === null) {
      if (firstEdLetter) return found("ed", firstCommand, firstCommandLine);
      if (extended) return found("unified", thisLine, source.line);
      source.patchLine = source.line;
      return null;
    }
    const stripCr = line.length >= 2 && line[line.length - 2] === 0x0d;
    indent = 0;
    let s = 0;
    for (; isBlank(line[s]) || line[s] === 0x58; s++) {
      indent = line[s] === 0x09 ? (indent + 8) & ~7 : indent + 1;
    }
    isCommand = isCommandLine(line, s) ?? isCommand;
    const edLetter = edCommand(line, s);
    if (!wantHeader && firstCommand < 0 && (edLetter || isCommand)) {
      firstCommand = thisLine;
      firstEdLetter = edLetter;
      firstCommandLine = source.line;
      scan.indent = indent;
      scan.stripCr = stripCr;
    }
    const text = decode(line.subarray(s, s + 20));

    if (!starsLast && text.startsWith("***") && isBlank(line[s + 3])) {
      apply(fetchName(line, s + 4, strip, true), scan, 0, false);
      wantHeader = false;
    } else if (text.startsWith("+++") && isBlank(line[s + 3])) {
      apply(fetchName(line, s + 4, strip, true), scan, 0, false);
      wantHeader = false;
      scan.stripCr = stripCr;
    } else if (text.startsWith("Index:")) {
      const fetched = fetchName(line, s + 6, strip, false);
      if (fetched.kind === "name") scan.names[2] = fetched.name;
      wantHeader = false;
      scan.stripCr = stripCr;
    } else if (text.startsWith("Prereq:")) {
      scan.revision = prerequisite(decode(line.subarray(s + 7)), source.patchLine, say);
    } else if (text.startsWith("diff --git ")) {
      if (extended) return found("unified", thisLine, source.line);
      const old = parseName(line, s + 11, strip);
      const next =
        old.name !== null && isSpace(line[old.end]) ? parseName(line, old.end, strip) : null;
      let end = next?.end ?? 0;
      while (isSpace(line[end])) end++;
      const valid = next !== null && next.name !== null && end >= line.length;
      scan.names[0] = valid ? old.name : null;
      scan.names[1] = valid ? (next?.name ?? null) : null;
      scan.git = true;
      wantHeader = false;
    } else if (scan.git && gitHeader(line, s, text, scan)) {
      if (text.startsWith("GIT binary patch")) return found("binary", thisLine, source.line);
      extended = true;
    } else {
      let t = s;
      while (line[t] === 0x2d && line[t + 1] === 0x20) t += 2;
      if (decode(line.subarray(t, t + 3)) === "---" && isBlank(line[t + 3])) {
        const fetched = fetchName(line, t + 4, strip, true);
        apply(fetched, scan, 1, true);
        if (fetched.kind === "devnull" || (fetched.kind === "name" && fetched.stamp !== "none")) {
          scan.nesting = (t - s) >> 1;
        }
        wantHeader = false;
        scan.stripCr = stripCr;
      }
    }
    if (wantHeader) continue;
    if (firstCommand >= 0 && decode(line.subarray(s)) === ".\n") {
      return found("ed", firstCommand, firstCommandLine);
    }
    if (text.startsWith("@@ -")) {
      scan.names = [scan.names[1], scan.names[0], scan.names[2]];
      scan.timestr = [scan.timestr[1], scan.timestr[0]];
      scan.stamps = [scan.stamps[1], scan.stamps[0]];
      let at = s + 4;
      if (line[at] === 0x30 && !isDigit(line[at + 1]))
        scan.existence[0] = nonexistence(scan.stamps[0]);
      while (line[at] !== 0x20 && line[at] !== 0x0a && at < line.length) at++;
      while (line[at] === 0x20) at++;
      if (line[at] === 0x2b && line[at + 1] === 0x30 && !isDigit(line[at + 2])) {
        scan.existence[1] = nonexistence(scan.stamps[1]);
      }
      scan.indent = indent;
      return found("unified", thisLine, source.line);
    }
    stars = text.startsWith("********");
    if (starsLast && indentLast === indent && text.startsWith("***") && isBlank(line[s + 3])) {
      return found("context", previousLine, source.line - 1);
    }
    if (lastWasCommand && (text.startsWith("< ") || text.startsWith("> "))) {
      return found("normal", previousLine, source.line - 1);
    }
  }
}

/** Record a `---`/`+++`/`***` name. GNU fills the slots crosswise and swaps them at `@@`. */
function apply(fetched: Fetched, scan: Scan, slot: Side, dashes: boolean): void {
  if (fetched.kind === "none") return;
  if (fetched.kind === "devnull") {
    scan.stamps[slot] = "epoch";
    return;
  }
  scan.names[slot] = fetched.name;
  scan.timestr[slot] = fetched.timestr;
  if (!dashes || fetched.stamp !== "none") scan.stamps[slot] = fetched.stamp;
}

function gitHeader(line: Uint8Array, s: number, text: string, scan: Scan): boolean {
  if (text.startsWith("index ")) {
    const match = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?:\s+(.*))?$/s.exec(decode(line.subarray(s)));
    if (match === null) return false;
    scan.existence[0] = blobExistence(match[1] ?? "");
    scan.existence[1] = blobExistence(match[2] ?? "");
    const mode = match[3] ?? "";
    if (mode.trim() !== "") scan.modes = [fileMode(mode), fileMode(mode)];
    return true;
  }
  const after = (prefix: string): string => decode(line.subarray(s + prefix.length));
  if (text.startsWith("old mode ")) scan.modes[0] = fileMode(after("old mode "));
  else if (text.startsWith("new mode ")) scan.modes[1] = fileMode(after("new mode "));
  else if (text.startsWith("deleted file mode ")) {
    scan.modes[0] = fileMode(after("deleted file mode "));
    scan.existence[1] = 2;
  } else if (text.startsWith("new file mode ")) {
    scan.modes[1] = fileMode(after("new file mode "));
    scan.existence[0] = 2;
  } else if (text.startsWith("rename from ")) scan.renames[0] = true;
  else if (text.startsWith("rename to ")) scan.renames[1] = true;
  else if (text.startsWith("copy from ")) scan.copies[0] = true;
  else if (text.startsWith("copy to ")) scan.copies[1] = true;
  else if (!text.startsWith("GIT binary patch")) return false;
  return true;
}

/** Whether either git mode names a symbolic link. */
export function touchesSymlink(header: Header): boolean {
  return header.modes.some((mode) => (mode & S_IFMT) === S_IFLNK);
}

function blobExistence(sha: string): Existence {
  if (/^0+$/.test(sha)) return 2;
  return EMPTY_BLOB.startsWith(sha) ? 1 : 0;
}

/** GNU's `fetchmode`: six octal digits of a regular file or symlink, else 0. */
function fileMode(text: string): number {
  const match = /^\s*([0-7]{6})\r?\n/.exec(text);
  if (match === null) return 0;
  const mode = Number.parseInt(match[1] ?? "", 8);
  const type = mode & S_IFMT;
  return type === S_IFREG || type === S_IFLNK ? mode : 0;
}

function nonexistence(stamp: Stamp): Existence {
  return stamp === "epoch" ? 2 : 1;
}

/** GNU names the line of the previous patch here, and so do we. */
function prerequisite(text: string, patchLine: number, say: (text: string) => void): string | null {
  const words = text.trim().split(/\s+/);
  const first = words[0] ?? "";
  if (words.length > 1) say(`Prereq: with multiple words at line ${patchLine} of patch\n`);
  return first === "" ? null : first;
}

function finish(scan: Scan): Header {
  return {
    kind: scan.kind,
    names: scan.names,
    timestr: scan.timestr,
    stamps: scan.stamps,
    existence: scan.existence,
    modes: scan.modes,
    git: scan.git,
    rename: scan.renames[0] && scan.renames[1],
    copy: scan.copies[0] && scan.copies[1],
    indent: scan.indent,
    nesting: scan.nesting,
    stripCr: scan.stripCr,
    start: scan.start,
    startLine: scan.startLine,
    revision: scan.revision,
  };
}

/** Whether a normal-diff command starts here; null leaves GNU's previous answer standing. */
function isCommandLine(line: Uint8Array, s: number): boolean | null {
  if (!isDigit(line[s])) return null;
  let t = s + 1;
  while (isDigit(line[t]) || line[t] === 0x2c) t++;
  if (line[t] !== 0x64 && line[t] !== 0x63 && line[t] !== 0x61) return null;
  t++;
  while (isDigit(line[t]) || line[t] === 0x2c) t++;
  while (isBlank(line[t])) t++;
  if (line[t] === 0x0d) t++;
  return line[t] === 0x0a;
}

/** GNU's `get_ed_command_letter`: whether the line is an ed command patch accepts. */
function edCommand(line: Uint8Array, s: number): boolean {
  let p = s;
  let pair = false;
  if (isDigit(line[p])) {
    while (isDigit(line[++p])) {}
    if (line[p] === 0x2c) {
      if (!isDigit(line[++p])) return false;
      while (isDigit(line[++p])) {}
      pair = true;
    }
  }
  const letter = line[p++];
  if (letter === 0x61 || letter === 0x69) {
    if (pair) return false;
  } else if (letter === 0x73) {
    if (decode(line.subarray(p, p + 4)) !== "/.//") return false;
    p += 4;
  } else if (letter !== 0x63 && letter !== 0x64) {
    return false;
  }
  while (isBlank(line[p])) p++;
  return line[p] === 0x0a;
}
