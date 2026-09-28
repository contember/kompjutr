// `ls` and `stat`. Long/recursive listings stream keyset pages; bare `ls`
// keeps the cheaper direct-directory shape.

import { basename, comparePaths, normalize } from "../../fs/path.js";
import type { ListCursor, Stat } from "../../fs/types.js";
import { type ByteStream, encode } from "../exec/bytes.js";
import { type Command, type CommandContext, fail } from "../exec/context.js";
import { displayUnder } from "../exec/display.js";
import { resolve } from "../exec/execute.js";
import { parseFlags, UsageError } from "./flags.js";

export const ls: Command = (context) => {
  try {
    const parsed = parseFlags(context.argv, {
      boolean: new Set(["-l", "-a", "-A", "-1", "-R", "-d", "-h"]),
      valued: new Set(),
    });
    const flags = new Set(parsed.flags.map((flag) => flag.name));
    // `-h` only changes how `-l` prints a size.
    const long: Long = flags.has("-l") ? { human: flags.has("-h") } : null;
    const all = flags.has("-a") || flags.has("-A");
    const recursive = flags.has("-R");
    const operands = parsed.operands.length === 0 ? ["."] : parsed.operands;

    let status = 0;
    const stream = (function* (): ByteStream {
      // GNU ls reports missing operands, then lists files, then directories,
      // each group in name order, every result under the operand as typed.
      const files: Array<{ operand: string; stat: Stat }> = [];
      const directories: Array<{ operand: string; path: string }> = [];
      for (const operand of operands) {
        const path = resolve(context.cwd, operand);
        const stat = context.fs.stat(path);
        if (stat === null) {
          context.warn(`cannot access '${operand}': No such file or directory`);
          status = 2;
        } else if (stat.type !== "dir" || flags.has("-d")) {
          files.push({ operand, stat });
        } else {
          directories.push({ operand, path });
        }
      }
      files.sort((left, right) => comparePaths(left.operand, right.operand));
      directories.sort((left, right) => comparePaths(left.operand, right.operand));

      for (const file of files) yield row(file.operand, file.stat, long);
      const headed = recursive || operands.length > 1;
      let first = files.length === 0;
      for (const { operand, path } of directories) {
        if (!first) yield encode("\n");
        first = false;
        if (recursive) {
          yield* listRecursive(context, operand, path, { long, all });
          continue;
        }
        if (headed) yield encode(`${operand}:\n`);
        if (long !== null) yield* listLongDirectory(context, path, all, long);
        else yield* listBareDirectory(context, path, all);
      }
    })();

    return { stdout: stream, status: () => status, truncated: () => false };
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

/** Null for a bare listing. */
type Long = { readonly human: boolean } | null;

function* listBareDirectory(context: CommandContext, path: string, all: boolean): ByteStream {
  const entries = context.fs.readdir(path);
  for (const entry of entries) {
    if (!all && entry.name.startsWith(".")) continue;
    yield row(entry.name, null, null);
  }
}

function* listLongDirectory(
  context: CommandContext,
  path: string,
  all: boolean,
  long: NonNullable<Long>,
): ByteStream {
  let after: ListCursor | undefined;
  const limit = listingPageSize(context);
  for (;;) {
    const page = context.fs.listEntries(path, after === undefined ? { limit } : { after, limit });
    for (const item of page.items) {
      const entry = item.entry;
      if (entry === null) continue;
      const name = basename(entry.path);
      if (!all && name.startsWith(".")) continue;
      yield row(name, entry, long);
    }
    if (page.next === null) return;
    after = page.next;
  }
}

function* listRecursive(
  context: CommandContext,
  operand: string,
  root: string,
  options: { long: Long; all: boolean },
): ByteStream {
  let after: ListCursor | undefined;
  let current: string | null = null;
  const limit = listingPageSize(context);
  for (;;) {
    const page = context.fs.listEntries(
      root,
      after === undefined ? { recursive: true, limit } : { recursive: true, after, limit },
    );
    for (const item of page.items) {
      if (!options.all && hiddenBelow(root, item.directory)) continue;
      if (item.directory !== current) {
        if (current !== null) yield encode("\n");
        yield encode(`${displayUnder(operand, root, item.directory)}:\n`);
        current = item.directory;
      }
      const entry = item.entry;
      if (entry === null) continue;
      const name = basename(entry.path);
      if (!options.all && name.startsWith(".")) continue;
      yield row(name, entry, options.long);
    }
    if (page.next === null) return;
    after = page.next;
  }
}

function listingPageSize(context: CommandContext): number {
  return Math.min(1_000, Math.max(1, (context.limitHint ?? 500) * 2));
}

function hiddenBelow(root: string, directory: string): boolean {
  const relative = directory.slice(root === "/" ? 1 : root.length + 1);
  return relative.split("/").some((segment) => segment.startsWith("."));
}

function row(name: string, stat: Stat | null, long: Long): Uint8Array {
  if (long === null || stat === null) return encode(`${name}\n`);
  const kind = stat.type === "dir" ? "d" : stat.type === "symlink" ? "l" : "-";
  const mode = permissions(stat.mode);
  const size = (long.human ? humanSize(stat.size) : String(stat.size)).padStart(8);
  const when = new Date(stat.mtime).toISOString().slice(0, 16).replace("T", " ");
  const target = stat.type === "symlink" && stat.target !== null ? ` -> ${stat.target}` : "";
  return encode(`${kind}${mode} ${size} ${when} ${name}${target}\n`);
}

const UNITS = "KMGTPE";

/**
 * uutils `ls -h`: powers of 1024, rounded up, one decimal below 10 — so
 * 1025 bytes is `1.1K` and 1048575 is `1024K`.
 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  let unit = 0;
  let scaled = bytes / 1024;
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit++;
  }
  const suffix = UNITS.charAt(unit);
  if (scaled < 10) {
    const tenths = Math.ceil(scaled * 10) / 10;
    if (tenths < 10) return `${tenths.toFixed(1)}${suffix}`;
  }
  return `${Math.ceil(scaled)}${suffix}`;
}

function permissions(mode: number): string {
  let out = "";
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (mode >> shift) & 0o7;
    out += bits & 4 ? "r" : "-";
    out += bits & 2 ? "w" : "-";
    out += bits & 1 ? "x" : "-";
  }
  return out;
}

export const stat: Command = (context) => {
  if (context.argv.length === 0) return fail(context, "missing operand", 2);
  let status = 0;
  const stream = (function* (): ByteStream {
    for (const operand of context.argv) {
      const path = resolve(context.cwd, operand);
      const found = context.fs.stat(path);
      if (found === null) {
        context.warn(`cannot stat '${operand}': No such file or directory`);
        status = 1;
        continue;
      }
      yield encode(
        `  File: ${normalize(path)}\n  Size: ${found.size}\t${found.type}\n` +
          `  Mode: ${(found.mode & 0o7777).toString(8).padStart(4, "0")}\n` +
          `Modify: ${new Date(found.mtime).toISOString()}\n`,
      );
    }
  })();
  return { stdout: stream, status: () => status, truncated: () => false };
};

export const listCommands: ReadonlyMap<string, Command> = new Map([
  ["ls", ls],
  ["stat", stat],
]);
