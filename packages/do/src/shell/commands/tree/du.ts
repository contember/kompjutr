// `du`. The filesystem has no blocks, so every size is apparent: a file counts
// its byte length, a symlink its target's byte length, and a directory 0 —
// what uutils `du -b` reports. The default and `-k` print that total in
// 1024-byte units rounded up, `-m` in MiB, `-b` in bytes.
//
// One operand is one keyset scan in path byte order. A directory's total is
// final once the scan passes its subtree successor, so only the open
// directories keep a running total. A sibling that sorts between `d` and `d/`
// (`d.txt`, `d-x/`) is visited while `d` is still open; open directories still
// close last-in first-out, because each is a prefix of the one above it.

import { comparePaths, dirname, subtreeSuccessor } from "../../../fs/path.js";
import { orderedScan } from "../../../fs/store/scan/scan-stream.js";
import type { ScanEntry } from "../../../fs/types.js";
import { type ByteStream, encode } from "../../exec/bytes.js";
import { type Command, type CommandContext, fail } from "../../exec/context.js";
import { displayUnder } from "../../exec/display.js";
import { resolve } from "../../exec/execute.js";
import { parseFlags, UsageError } from "../flags.js";
import { humanSize } from "./size.js";

const FRAME_OVERHEAD_BYTES = 64;
const INODE_BYTES = 16;

interface DuOptions {
  readonly all: boolean;
  readonly maxDepth: number | null;
  readonly total: boolean;
  readonly human: boolean;
  readonly unit: number;
}

interface Frame {
  readonly path: string;
  readonly successor: string;
  readonly display: string;
  readonly depth: number;
  bytes: number;
  readonly release: () => void;
}

export const du: Command = (context) => {
  let options: DuOptions;
  let operands: readonly string[];
  try {
    const parsed = parseFlags(context.argv, {
      boolean: new Set([
        "-a",
        "-s",
        "-c",
        "-h",
        "-b",
        "-k",
        "-m",
        "--all",
        "--summarize",
        "--total",
        "--human-readable",
        "--bytes",
        "--apparent-size",
      ]),
      valued: new Set(["-d", "--max-depth"]),
    });
    options = duOptions(parsed.flags);
    operands = parsed.operands.length === 0 ? ["."] : parsed.operands;
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 1);
    throw error;
  }

  let status = 0;
  const stream = (function* (): ByteStream {
    let total = 0;
    const roots = new Set<number>();
    for (const operand of operands) {
      const path = resolve(context.cwd, operand);
      // A trailing slash asks for the directory a symlink names, as in POSIX path resolution.
      const stat = operand.endsWith("/") ? context.fs.statTarget(path) : context.fs.stat(path);
      if (stat === null) {
        context.warn(`cannot access '${operand}': No such file or directory`);
        status = 1;
        continue;
      }
      if (stat.type !== "dir") {
        total += stat.size;
        yield row(options, stat.size, operand);
        continue;
      }
      // uutils skips a directory operand it has already reported.
      if (roots.has(stat.ino)) continue;
      roots.add(stat.ino);
      const counted = { bytes: 0 };
      yield* directory(context, options, operand, path, counted);
      total += counted.bytes;
    }
    if (options.total) yield row(options, total, "total");
  })();
  return { stdout: stream, status: () => status, truncated: () => false };
};

function duOptions(flags: ReadonlyArray<{ name: string; value: string | null }>): DuOptions {
  const names = new Set(flags.map((flag) => flag.name));
  let maxDepth: number | null = null;
  for (const flag of flags) {
    if (flag.name !== "-d" && flag.name !== "--max-depth") continue;
    const value = flag.value ?? "";
    if (!/^\d+$/.test(value)) throw new UsageError(`invalid maximum depth '${value}'`);
    maxDepth = Number.parseInt(value, 10);
  }
  if (names.has("-s") || names.has("--summarize")) {
    if (maxDepth !== null && maxDepth !== 0) {
      throw new UsageError(`summarizing conflicts with --max-depth=${maxDepth}`);
    }
    maxDepth = 0;
  }
  // uutils ranks the unit flags, not their order: -b over -k over -m.
  const bytes = names.has("-b") || names.has("--bytes");
  const unit = bytes ? 1 : names.has("-k") ? 1024 : names.has("-m") ? 1024 * 1024 : 1024;
  return {
    all: names.has("-a") || names.has("--all"),
    maxDepth,
    total: names.has("-c") || names.has("--total"),
    human: names.has("-h") || names.has("--human-readable"),
    unit,
  };
}

function* directory(
  context: CommandContext,
  options: DuOptions,
  operand: string,
  root: string,
  counted: { bytes: number },
): ByteStream {
  // Hard links count once per operand, as in uutils.
  const linked = new Set<number>();
  const releases: Array<() => void> = [];
  const open: Frame[] = [];
  const shows = (depth: number): boolean => options.maxDepth === null || depth <= options.maxDepth;
  const push = (path: string, display: string, depth: number): void => {
    open.push({
      path,
      successor: subtreeSuccessor(path),
      display,
      depth,
      bytes: 0,
      release: context.fs.retained.retain(
        FRAME_OVERHEAD_BYTES + 2 * path.length,
        "du open directory",
      ),
    });
  };
  const close = function* (): ByteStream {
    const frame = open.pop();
    if (frame === undefined) return;
    frame.release();
    parentOf(open, frame.path).bytes += frame.bytes;
    if (shows(frame.depth)) yield row(options, frame.bytes, frame.display);
  };

  let real: string | null = null;
  try {
    for (const entry of orderedScan((page) => context.fs.scan(root, page))) {
      if (real === null) {
        real = isUnder(entry.path, root) ? root : context.fs.realpath(root);
        push(real, operand, 0);
      }
      while (open.length > 1 && comparePaths(entry.path, open.at(-1)?.successor ?? "") >= 0) {
        yield* close();
      }
      const display = displayUnder(operand, real, entry.path);
      const depth = depthUnder(real, entry.path);
      if (entry.type === "dir") {
        push(entry.path, display, depth);
        continue;
      }
      if (duplicateLink(context, linked, releases, entry)) continue;
      parentOf(open, entry.path).bytes += entry.size;
      if (options.all && shows(depth)) yield row(options, entry.size, display);
    }
    if (real === null) push(root, operand, 0);
    while (open.length > 1) yield* close();
    const top = open.pop();
    if (top !== undefined) {
      top.release();
      counted.bytes = top.bytes;
      yield row(options, top.bytes, operand);
    }
  } finally {
    for (const frame of open) frame.release();
    for (const release of releases) release();
  }
}

function duplicateLink(
  context: CommandContext,
  linked: Set<number>,
  releases: Array<() => void>,
  entry: ScanEntry,
): boolean {
  if (entry.nlink < 2) return false;
  if (linked.has(entry.ino)) return true;
  releases.push(context.fs.retained.retain(INODE_BYTES, "du hard link inode"));
  linked.add(entry.ino);
  return false;
}

/** The open frame for `path`'s parent. It is open: the scan is inside its subtree. */
function parentOf(open: readonly Frame[], path: string): Frame {
  const parent = dirname(path);
  for (let index = open.length - 1; index >= 0; index--) {
    const frame = open[index];
    if (frame?.path === parent) return frame;
  }
  throw new Error(`du: no open directory for ${path}`);
}

function depthUnder(root: string, path: string): number {
  return path.slice(root === "/" ? 1 : root.length + 1).split("/").length;
}

function isUnder(path: string, directory: string): boolean {
  return path.startsWith(directory === "/" ? "/" : `${directory}/`);
}

function row(options: DuOptions, bytes: number, name: string): Uint8Array {
  const size = options.human ? humanSize(bytes) : String(Math.ceil(bytes / options.unit));
  return encode(`${size}\t${name}\n`);
}
