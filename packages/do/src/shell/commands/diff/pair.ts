// One file pair: identity shortcuts first, then the bytes. Equal inodes or
// equal content ids prove equality without a read, and under `-q` unequal
// sizes prove a difference. Only a pair that survives both is read, both
// sides in one batch, and held against the retained budget until its output
// is built.

import { concat, encode, equals, firstNul, NEWLINE } from "../../exec/bytes.js";
import type { CommandContext } from "../../exec/context.js";
import { groups, type Line, normal, unified } from "./format.js";
import { editScript } from "./myers.js";
import type { DiffOptions } from "./options.js";

export type SideKind = "file" | "dir" | "absent";

/** One operand or directory entry, symlinks already followed. */
export interface Side {
  /** As GNU prints it: the operand, or the parent's name joined with the entry's. */
  readonly name: string;
  /** Absolute filesystem path; unused for stdin and absent sides. */
  readonly path: string;
  readonly kind: SideKind;
  readonly size: number;
  readonly mtime: number;
  readonly ino: number | null;
  readonly contentId: Uint8Array | null;
  /** Already read: stdin. */
  readonly bytes: Uint8Array | null;
}

export interface Comparison {
  readonly context: CommandContext;
  readonly options: DiffOptions;
  /** 0 same, 1 different, 2 trouble; only ever raised. */
  status: number;
}

export function raise(comparison: Comparison, status: number): void {
  comparison.status = Math.max(comparison.status, status);
}

/** The output for a pair of regular (or absent) files; `nested` adds GNU's per-file header. */
export function comparePair(
  comparison: Comparison,
  a: Side,
  b: Side,
  nested: boolean,
): Uint8Array | null {
  const { options } = comparison;
  if (provablyEqual(a, b)) return identical(comparison, a, b);
  if (options.brief && a.bytes === null && b.bytes === null && a.size !== b.size) {
    return different(comparison, a, b);
  }

  const releases: Array<() => void> = [];
  try {
    const [aBytes, bBytes] = readPair(comparison.context, a, b, releases);
    if (equals(aBytes, bBytes)) return identical(comparison, a, b);
    if (options.brief) return different(comparison, a, b);
    raise(comparison, 1);
    if (firstNul(aBytes) >= 0 || firstNul(bBytes) >= 0) {
      return encode(`Binary files ${a.name} and ${b.name} differ\n`);
    }
    const aLines = split(aBytes);
    const bLines = split(bBytes);
    const ids = new Map<string, number>();
    const changes = groups(editScript(intern(aLines, ids), intern(bLines, ids)));
    const aLabel = quoteName(a.name);
    const bLabel = quoteName(b.name);
    const header = nested ? [encode(`diff${options.switches} ${aLabel} ${bLabel}\n`)] : [];
    const body =
      options.contextLines === null
        ? [...normal(changes, aLines, bLines)]
        : [
            encode(`--- ${aLabel}\t${timestamp(a.mtime)}\n`),
            encode(`+++ ${bLabel}\t${timestamp(b.mtime)}\n`),
            ...unified(changes, aLines, bLines, options.contextLines),
          ];
    return concat([...header, ...body]);
  } finally {
    for (const release of releases) release();
  }
}

function provablyEqual(a: Side, b: Side): boolean {
  if (a.bytes !== null || b.bytes !== null) return false;
  if (a.ino !== null && a.ino === b.ino) return true;
  if (a.size === 0 && b.size === 0) return true;
  return a.contentId !== null && b.contentId !== null && equals(a.contentId, b.contentId);
}

function identical(comparison: Comparison, a: Side, b: Side): Uint8Array | null {
  if (!comparison.options.reportIdentical) return null;
  return encode(`Files ${a.name} and ${b.name} are identical\n`);
}

function different(comparison: Comparison, a: Side, b: Side): Uint8Array {
  raise(comparison, 1);
  return encode(`Files ${a.name} and ${b.name} differ\n`);
}

function readPair(
  context: CommandContext,
  a: Side,
  b: Side,
  releases: Array<() => void>,
): [Uint8Array, Uint8Array] {
  const wanted = [a, b].filter((side) => side.kind === "file" && side.bytes === null);
  for (const side of wanted) releases.push(context.fs.retained.retain(side.size, "diff input"));
  const batch =
    wanted.length === 0
      ? new Map<string, Uint8Array>()
      : context.fs.readFiles(
          wanted.map((side) => side.path),
          { budget: context.fs.readBudget },
        ).files;
  const bytesOf = (side: Side): Uint8Array => {
    if (side.bytes !== null) return side.bytes;
    if (side.kind === "absent") return new Uint8Array(0);
    return batch.get(side.path) ?? context.fs.readFile(side.path);
  };
  return [bytesOf(a), bytesOf(b)];
}

const NAMED_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x07, "\\a"],
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0b, "\\v"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
]);

/**
 * GNU diff's own `c_escape` for header names: a name with a space, quote,
 * backslash, control byte, or byte above 0x7f is double-quoted with C escapes.
 * It tests a signed char, so DEL passes through bare and high bytes go octal.
 */
function quoteName(name: string): string {
  let quoted = "";
  let needed = false;
  for (const byte of encode(name)) {
    const named = NAMED_ESCAPES.get(byte);
    if (named !== undefined) {
      quoted += named;
      needed = true;
    } else if (byte < 0x20 || byte > 0x7f) {
      quoted += `\\${byte.toString(8).padStart(3, "0")}`;
      needed = true;
    } else {
      if (byte === 0x20) needed = true;
      quoted += String.fromCharCode(byte);
    }
  }
  return needed ? `"${quoted}"` : name;
}

function split(bytes: Uint8Array): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== NEWLINE) continue;
    lines.push({ text: bytes.subarray(start, index), terminated: true });
    start = index + 1;
  }
  if (start < bytes.length) lines.push({ text: bytes.subarray(start), terminated: false });
  return lines;
}

/** Equal lines share an id. A final line without a newline differs from one with it. */
function intern(lines: readonly Line[], ids: Map<string, number>): Int32Array {
  const out = new Int32Array(lines.length);
  for (const [index, line] of lines.entries()) {
    let key = line.terminated ? "\n" : "";
    for (const byte of line.text) key += String.fromCharCode(byte);
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    out[index] = id;
  }
  return out;
}

/** GNU's `%Y-%m-%d %H:%M:%S.%N %z`, in UTC. */
function timestamp(milliseconds: number): string {
  const iso = new Date(milliseconds).toISOString();
  const nanoseconds = `${iso.slice(20, 23)}000000`;
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${nanoseconds} +0000`;
}
