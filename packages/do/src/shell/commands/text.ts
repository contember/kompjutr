// `pwd`, `cd`, `true`, `false`, `which`, `sort`, `uniq`.

import { comparePaths, normalize } from "../../fs/path.js";
import { type ByteStream, decode, encode, lines, owned, terminated } from "../exec/bytes.js";
import { type Command, fail, result } from "../exec/context.js";
import { resolve } from "../exec/execute.js";
import { parseFlags } from "./flags.js";

function* nothing(): ByteStream {
  // Nothing.
}

function* one(bytes: Uint8Array): ByteStream {
  if (bytes.length > 0) yield bytes;
}

export const pwd: Command = (context) => result(one(encode(`${context.cwd}\n`)));

/**
 * `cd` is the reason the session owns a working directory: 60 % of the
 * corpus's lines carry a `cd X &&` prefix purely because the previous call's
 * directory did not survive. It validates before it persists — a session
 * must never hold a `cwd` that is not there.
 */
export const cd: Command = (context) => {
  const target = context.argv[0];
  if (target === undefined) return fail(context, "no target directory", 2);
  if (context.argv.length > 1) return fail(context, "too many arguments", 2);

  const path = normalize(resolve(context.cwd, target));
  const stat = context.fs.statTarget(path);
  if (stat === null) return fail(context, `${target}: No such file or directory`);
  if (stat.type !== "dir") return fail(context, `${target}: Not a directory`);

  context.chdir(path);
  return result(nothing());
};

export const yes: Command = () => result(nothing(), 0);
export const no: Command = () => result(nothing(), 1);

export const which: Command = (context) => {
  let status = 0;
  const stream = (function* (): ByteStream {
    for (const name of context.argv) {
      if (KNOWN.has(name)) yield encode(`/usr/bin/${name}\n`);
      else status = 1;
    }
  })();
  return { stdout: stream, status: () => status, truncated: () => false };
};

/** Names `which` will admit to. Filled in by the registry at load. */
const KNOWN = new Set<string>();

export function registerKnownCommands(names: Iterable<string>): void {
  for (const name of names) KNOWN.add(name);
}

export const sort: Command = async (context) => {
  const parsed = parseFlags(context.argv, {
    boolean: new Set(["-r", "-n", "-u", "-f", "--reverse", "--numeric-sort", "--unique"]),
    valued: new Set(),
  });
  const flags = new Set(parsed.flags.map((flag) => flag.name));
  const reverse = flags.has("-r") || flags.has("--reverse");
  const numeric = flags.has("-n") || flags.has("--numeric-sort");
  const unique = flags.has("-u") || flags.has("--unique");
  const fold = flags.has("-f");

  const source = sourceFor(context, parsed.operands);
  if (source === null) return result(nothing());

  const releases: Array<() => void> = [];
  const release = releaseAll(releases);
  const collected: string[] = [];
  try {
    for await (const text of lines(source, context.fs.retained)) {
      releases.push(context.fs.retained.retain(text.length * 2, "sort input"));
      collected.push(decode(text));
    }
    collected.sort((left, right) => {
      if (numeric) {
        const difference = Number.parseFloat(left) - Number.parseFloat(right);
        if (!Number.isNaN(difference) && difference !== 0) return difference;
      }
      const a = fold ? left.toLowerCase() : left;
      const b = fold ? right.toLowerCase() : right;
      return comparePaths(a, b);
    });
    if (reverse) collected.reverse();

    const out = unique
      ? collected.filter((value, index) => value !== collected[index - 1])
      : collected;
    return result(owned(terminated(out.map((value) => encode(value))), release));
  } catch (error) {
    release();
    throw error;
  }
};

function releaseAll(releases: ReadonlyArray<() => void>): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases) release();
  };
}

export const uniq: Command = (context) => {
  const parsed = parseFlags(context.argv, {
    boolean: new Set(["-c", "-d", "-u", "--count"]),
    valued: new Set(),
  });
  const flags = new Set(parsed.flags.map((flag) => flag.name));
  const withCount = flags.has("-c") || flags.has("--count");
  const onlyRepeated = flags.has("-d");
  const onlyUnique = flags.has("-u");

  const source = sourceFor(context, parsed.operands);
  if (source === null) return result(nothing());

  const stream = (async function* (): ByteStream {
    let previous: string | null = null;
    let releasePrevious: (() => void) | null = null;
    let run = 0;
    const flush = function* (): ByteStream {
      if (previous === null) return;
      if (onlyRepeated && run < 2) return;
      if (onlyUnique && run > 1) return;
      yield encode(withCount ? `${String(run).padStart(7)} ${previous}\n` : `${previous}\n`);
    };
    try {
      for await (const text of lines(source, context.fs.retained)) {
        const release = context.fs.retained.retain(text.length * 2, "uniq line");
        const value = decode(text);
        if (value === previous) {
          release();
          run++;
          continue;
        }
        yield* flush();
        releasePrevious?.();
        previous = value;
        releasePrevious = release;
        run = 1;
      }
      yield* flush();
    } finally {
      releasePrevious?.();
    }
  })();
  return result(stream);
};

function sourceFor(
  context: Parameters<Command>[0],
  operands: readonly string[],
): ByteStream | null {
  if (operands.length === 0) return context.stdin;
  return (function* (): ByteStream {
    for (const operand of operands) {
      const path = resolve(context.cwd, operand);
      const stat = context.fs.statTarget(path);
      if (stat === null) {
        context.warn(`${operand}: No such file or directory`);
        continue;
      }
      if (stat.type !== "file") {
        yield context.fs.readFile(path);
        continue;
      }
      const chunkSize = context.fs.readBudget;
      for (let offset = 0; offset < stat.size; offset += chunkSize) {
        const length = Math.min(chunkSize, stat.size - offset);
        const release = context.fs.retained.retain(length, "text file input");
        try {
          yield context.fs.readRange(path, offset, length);
        } finally {
          release();
        }
      }
    }
  })();
}

export const textCommands: ReadonlyMap<string, Command> = new Map([
  ["pwd", pwd],
  ["cd", cd],
  ["true", yes],
  ["false", no],
  ["which", which],
  ["sort", sort],
  ["uniq", uniq],
]);
