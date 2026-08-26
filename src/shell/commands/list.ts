// `ls`, `find`, `stat`. Long/recursive listings and indexed find stream
// keyset pages; bare `ls` keeps the cheaper direct-directory shape.

import { basename, normalize } from "../../fs/path.js";
import type { ListCursor, Stat } from "../../fs/types.js";
import { type ByteStream, encode } from "../exec/bytes.js";
import { type Command, type CommandContext, fail, result } from "../exec/context.js";
import { resolve } from "../exec/execute.js";
import { compileIncludeGlob, sqlGlobFor } from "../exec/glob.js";
import { count, parseFlags, UsageError } from "./flags.js";

export const ls: Command = (context) => {
  try {
    const parsed = parseFlags(context.argv, {
      boolean: new Set(["-l", "-a", "-A", "-1", "-R", "-d"]),
      valued: new Set(),
    });
    const flags = new Set(parsed.flags.map((flag) => flag.name));
    const long = flags.has("-l");
    const all = flags.has("-a") || flags.has("-A");
    const recursive = flags.has("-R");
    const targets = parsed.operands.length === 0 ? [context.cwd] : parsed.operands;

    let status = 0;
    const stream = (function* (): ByteStream {
      const many = targets.length > 1;
      let first = true;
      for (const operand of targets) {
        const path = resolve(context.cwd, operand);
        const stat = context.fs.stat(path);
        if (stat === null) {
          context.warn(`cannot access '${operand}': No such file or directory`);
          status = 2;
          continue;
        }
        if (stat.type !== "dir" || flags.has("-d")) {
          yield row(basename(path), stat, long);
          continue;
        }
        if (recursive) {
          if (!first) yield encode("\n");
          yield* listRecursive(context, path, { long, all });
          first = false;
          continue;
        }
        if (many) {
          if (!first) yield encode("\n");
          yield encode(`${path}:\n`);
        }
        first = false;
        if (long) yield* listLongDirectory(context, path, all);
        else yield* listBareDirectory(context, path, all);
      }
    })();

    return { stdout: stream, status: () => status };
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

function* listBareDirectory(context: CommandContext, path: string, all: boolean): ByteStream {
  const entries = context.fs.readdir(path);
  for (const entry of entries) {
    if (!all && entry.name.startsWith(".")) continue;
    yield row(entry.name, null, false);
  }
}

function* listLongDirectory(context: CommandContext, path: string, all: boolean): ByteStream {
  let after: ListCursor | undefined;
  const limit = listingPageSize(context);
  for (;;) {
    const page = context.fs.listEntries(path, after === undefined ? { limit } : { after, limit });
    for (const item of page.items) {
      const entry = item.entry;
      if (entry === null) continue;
      const name = basename(entry.path);
      if (!all && name.startsWith(".")) continue;
      yield row(name, entry, true);
    }
    if (page.next === null) return;
    after = page.next;
  }
}

function* listRecursive(
  context: CommandContext,
  root: string,
  options: { long: boolean; all: boolean },
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
        yield encode(`${item.directory}:\n`);
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

function row(name: string, stat: Stat | null, long: boolean): Uint8Array {
  if (!long || stat === null) return encode(`${name}\n`);
  const kind = stat.type === "dir" ? "d" : stat.type === "symlink" ? "l" : "-";
  const mode = permissions(stat.mode);
  const size = String(stat.size).padStart(8);
  const when = new Date(stat.mtime).toISOString().slice(0, 16).replace("T", " ");
  const target = stat.type === "symlink" && stat.target !== null ? ` -> ${stat.target}` : "";
  return encode(`${kind}${mode} ${size} ${when} ${name}${target}\n`);
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

export const find: Command = (context) => {
  try {
    let root: string | null = null;
    let namePattern: string | null = null;
    let type: "f" | "d" | "l" | null = null;
    let maxDepth: number | null = null;

    for (let index = 0; index < context.argv.length; index++) {
      const arg = context.argv[index];
      if (arg === undefined) continue;
      if (arg === "-name") {
        namePattern = context.argv[index + 1] ?? null;
        index++;
        continue;
      }
      if (arg === "-type") {
        const value = context.argv[index + 1];
        if (value !== "f" && value !== "d" && value !== "l") {
          throw new UsageError(`unknown -type '${value}'`);
        }
        type = value;
        index++;
        continue;
      }
      if (arg === "-maxdepth") {
        maxDepth = count(context.argv[index + 1] ?? "", "-maxdepth");
        index++;
        continue;
      }
      if (arg.startsWith("-")) {
        throw new UsageError(`${arg} is not supported; supported: -name, -type, -maxdepth`);
      }
      if (root !== null) throw new UsageError("only one starting point is supported");
      root = arg;
    }

    const start = resolve(context.cwd, root ?? ".");
    const stat = context.fs.stat(start);
    if (stat === null) return fail(context, `'${root ?? "."}': No such file or directory`);

    const matcher = namePattern === null ? null : compileIncludeGlob(namePattern);
    const depthOf = (path: string): number =>
      path === start ? 0 : path.slice(start.length).split("/").length - 1;

    const stream = (function* (): ByteStream {
      // The root itself is a result in find, before anything under it.
      if (typeMatches(stat.type, type) && (matcher === null || matcher.test(start))) {
        yield encode(`${start}\n`);
      }

      // `-name` with no type filter lowers straight to an indexed GLOB.
      if (matcher !== null && type === null && maxDepth === null) {
        const absolute = `${start === "/" ? "" : start}/*${trailingLiteral(namePattern ?? "")}`;
        const sql = sqlGlobFor(absolute);
        if (sql !== null) {
          const pageSize = Math.min(1_000, Math.max(1, (context.limitHint ?? 500) * 2));
          let after: string | undefined;
          for (;;) {
            const page = context.fs.globPage(
              start,
              sql,
              after === undefined ? { limit: pageSize } : { after, limit: pageSize },
            );
            for (const path of page.paths) {
              if (matcher.test(path)) yield encode(`${path}\n`);
            }
            if (page.next === null) return;
            after = page.next;
          }
        }
      }

      let after: string | undefined;
      for (;;) {
        const page = context.fs.scan(
          start,
          after === undefined ? { limit: 1_000 } : { after, limit: 1_000 },
        );
        for (const entry of page) {
          if (maxDepth !== null && depthOf(entry.path) > maxDepth) continue;
          if (!typeMatches(entry.type, type)) continue;
          if (matcher !== null && !matcher.test(entry.path)) continue;
          yield encode(`${entry.path}\n`);
        }
        if (page.length < 1_000) return;
        after = page[page.length - 1]?.path;
        if (after === undefined) return;
      }
    })();

    return result(stream);
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

function typeMatches(actual: string, wanted: "f" | "d" | "l" | null): boolean {
  if (wanted === null) return true;
  if (wanted === "f") return actual === "file";
  if (wanted === "d") return actual === "dir";
  return actual === "symlink";
}

/** The longest trailing run with no glob metacharacter. */
function trailingLiteral(pattern: string): string {
  return /[^*?[\]]*$/.exec(pattern)?.[0] ?? "";
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
  return { stdout: stream, status: () => status };
};

export const listCommands: ReadonlyMap<string, Command> = new Map([
  ["ls", ls],
  ["find", find],
  ["stat", stat],
]);
