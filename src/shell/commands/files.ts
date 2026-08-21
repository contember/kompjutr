// `cp`, `mv`, `rm`, `mkdir`, `touch`.
//
// All five go through the bulk primitives, so a recursive removal is a range
// delete and costs what removing one file costs — the §7 target that makes
// `rm -rf` on a 5,000-file tree O(1) rather than O(files).

import { basename, join } from "../../fs/path.js";
import type { WriteEntry } from "../../fs/types.js";
import { type ByteStream, encode } from "../exec/bytes.js";
import { type Command, type CommandContext, fail, result } from "../exec/context.js";
import { resolve } from "../exec/execute.js";
import { parseFlags, UsageError } from "./flags.js";

function* nothing(): ByteStream {
  // These commands are silent on success, like their originals.
}

export const cp: Command = (context) => {
  try {
    const parsed = parseFlags(context.argv, {
      boolean: new Set(["-r", "-R", "-f", "-p", "--recursive", "-v"]),
      valued: new Set(),
    });
    const recursive = parsed.flags.some(
      (flag) => flag.name === "-r" || flag.name === "-R" || flag.name === "--recursive",
    );
    const paths = parsed.operands.map((operand) => resolve(context.cwd, operand));
    const destination = paths.pop();
    if (destination === undefined || paths.length === 0) {
      return fail(context, "usage: cp [-r] SOURCE... DEST", 2);
    }

    const destinationStat = context.fs.stat(destination);
    const intoDirectory = destinationStat?.type === "dir";
    if (paths.length > 1 && !intoDirectory) {
      return fail(context, `target '${destination}' is not a directory`, 2);
    }

    const entries: WriteEntry[] = [];
    for (const source of paths) {
      const stat = context.fs.stat(source);
      if (stat === null) {
        return fail(context, `cannot stat '${source}': No such file or directory`);
      }
      const target = intoDirectory ? join(destination, basename(source)) : destination;

      if (stat.type !== "dir") {
        entries.push({
          path: target,
          bytes: context.fs.readFile(source),
          mode: stat.mode & 0o7777,
          contentId: stat.contentId ?? undefined,
        });
        continue;
      }

      if (!recursive) return fail(context, `-r not specified; omitting directory '${source}'`);
      collectSubtree(context, source, target, entries);
    }

    // One write for the whole copy, however many files it covers.
    context.fs.writeFiles(entries);
    return result(nothing());
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

function collectSubtree(
  context: CommandContext,
  source: string,
  target: string,
  entries: WriteEntry[],
): void {
  entries.push({ path: target, mode: 0o755 });
  let after: string | undefined;
  for (;;) {
    const page = context.fs.scan(
      source,
      after === undefined ? { limit: 1_000 } : { after, limit: 1_000 },
    );
    if (page.length === 0) return;

    const files = page.filter((entry) => entry.type === "file");
    const contents = new Map<string, Uint8Array>();
    let pending: readonly string[] = files.map((entry) => entry.path);
    while (pending.length > 0) {
      const batch = context.fs.readFiles(pending, { budget: context.fs.readBudget });
      for (const [path, bytes] of batch.files) contents.set(path, bytes);
      pending = batch.remaining;
    }

    for (const entry of page) {
      const relative = entry.path.slice(source.length);
      const path = `${target}${relative}`;
      if (entry.type === "dir") {
        entries.push({ path, mode: entry.mode & 0o7777 });
        continue;
      }
      if (entry.type === "symlink" && entry.target !== null) {
        entries.push({ path, target: entry.target });
        continue;
      }
      const bytes = contents.get(entry.path);
      if (bytes !== undefined) {
        entries.push({ path, bytes, mode: entry.mode & 0o7777 });
      }
    }

    if (page.length < 1_000) return;
    after = page[page.length - 1]?.path;
    if (after === undefined) return;
  }
}

export const mv: Command = (context) => {
  const paths = context.argv.map((operand) => resolve(context.cwd, operand));
  const destination = paths.pop();
  if (destination === undefined || paths.length === 0) {
    return fail(context, "usage: mv SOURCE... DEST", 2);
  }
  const intoDirectory = context.fs.stat(destination)?.type === "dir";
  if (paths.length > 1 && !intoDirectory) {
    return fail(context, `target '${destination}' is not a directory`, 2);
  }
  for (const source of paths) {
    if (context.fs.stat(source) === null) {
      return fail(context, `cannot stat '${source}': No such file or directory`);
    }
    context.fs.rename(source, intoDirectory ? join(destination, basename(source)) : destination);
  }
  return result(nothing());
};

export const rm: Command = (context) => {
  try {
    const parsed = parseFlags(context.argv, {
      boolean: new Set(["-r", "-R", "-f", "-v", "--recursive", "--force"]),
      valued: new Set(),
    });
    const flags = new Set(parsed.flags.map((flag) => flag.name));
    const recursive = flags.has("-r") || flags.has("-R") || flags.has("--recursive");
    const force = flags.has("-f") || flags.has("--force");

    if (parsed.operands.length === 0) {
      return force ? result(nothing()) : fail(context, "missing operand", 2);
    }

    const paths: string[] = [];
    for (const operand of parsed.operands) {
      const path = resolve(context.cwd, operand);
      const stat = context.fs.stat(path);
      if (stat === null) {
        if (force) continue;
        return fail(context, `cannot remove '${operand}': No such file or directory`);
      }
      if (stat.type === "dir" && !recursive) {
        return fail(context, `cannot remove '${operand}': Is a directory`);
      }
      paths.push(path);
    }

    // A range delete: one call, whatever the subtree holds.
    if (paths.length > 0) context.fs.removeFiles(paths, { recursive, force });
    return result(nothing());
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

export const mkdir: Command = (context) => {
  try {
    const parsed = parseFlags(context.argv, {
      boolean: new Set(["-p", "-v", "--parents"]),
      valued: new Set(["-m", "--mode"]),
    });
    const parents = parsed.flags.some((flag) => flag.name === "-p" || flag.name === "--parents");
    if (parsed.operands.length === 0) return fail(context, "missing operand", 2);

    const paths = parsed.operands.map((operand) => resolve(context.cwd, operand));
    if (!parents) {
      for (const path of paths) {
        if (context.fs.stat(path) !== null) {
          return fail(context, `cannot create directory '${path}': File exists`);
        }
      }
    }
    context.fs.makeDirectories(paths);
    return result(nothing());
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

export const touch: Command = (context) => {
  if (context.argv.length === 0) return fail(context, "missing file operand", 2);
  const entries: WriteEntry[] = [];
  for (const operand of context.argv) {
    const path = resolve(context.cwd, operand);
    const stat = context.fs.stat(path);
    // An existing file keeps its bytes; only the timestamp moves.
    entries.push(
      stat === null
        ? { path, bytes: encode("") }
        : { path, bytes: context.fs.readFile(path), mode: stat.mode & 0o7777 },
    );
  }
  context.fs.writeFiles(entries);
  return result(nothing());
};

export const fileCommands: ReadonlyMap<string, Command> = new Map([
  ["cp", cp],
  ["mv", mv],
  ["rm", rm],
  ["mkdir", mkdir],
  ["touch", touch],
]);
