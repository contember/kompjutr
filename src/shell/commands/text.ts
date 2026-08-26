// `echo`, `pwd`, `cd`, `true`, `false`, `which`, `sort`, `uniq`, `sed`.
//
// `sed` ships two forms and nothing else: `s/a/b/[gi]` and `-n Np`. The
// corpus has seven `sed` invocations and they are all one of those. Growing
// a script parser here is how a shell turns into a bash port, so anything
// else is a named error pointing at the container. See §2 of the plan.

import { comparePaths, normalize } from "../../fs/path.js";
import { type ByteStream, decode, encode, lines, terminated } from "../exec/bytes.js";
import { type Command, fail, result } from "../exec/context.js";
import { resolve } from "../exec/execute.js";
import { parseFlags, UsageError } from "./flags.js";
import { compilePattern, PatternError } from "./regex.js";

function* nothing(): ByteStream {
  // Nothing.
}

function* one(bytes: Uint8Array): ByteStream {
  if (bytes.length > 0) yield bytes;
}

export const echo: Command = (context) => {
  const noNewline = context.argv[0] === "-n";
  const words = noNewline ? context.argv.slice(1) : context.argv;
  return result(one(encode(`${words.join(" ")}${noNewline ? "" : "\n"}`)));
};

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
  return { stdout: stream, status: () => status };
};

/** Names `which` will admit to. Filled in by the registry at load. */
const KNOWN = new Set<string>();

export function registerKnownCommands(names: Iterable<string>): void {
  for (const name of names) KNOWN.add(name);
}

export const sort: Command = (context) => {
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

  const collected = [...lines(source)].map(decode);
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
  return result(terminated(out.map((value) => encode(value))));
};

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

  const stream = (function* (): ByteStream {
    let previous: string | null = null;
    let run = 0;
    const flush = function* (): ByteStream {
      if (previous === null) return;
      if (onlyRepeated && run < 2) return;
      if (onlyUnique && run > 1) return;
      yield encode(withCount ? `${String(run).padStart(7)} ${previous}\n` : `${previous}\n`);
    };
    for (const text of lines(source)) {
      const value = decode(text);
      if (value === previous) {
        run++;
        continue;
      }
      yield* flush();
      previous = value;
      run = 1;
    }
    yield* flush();
  })();
  return result(stream);
};

/** `s/a/b/[gi]` or `-n Np`, and a named error for anything else. */
export const sed: Command = (context) => {
  try {
    const quiet = context.argv[0] === "-n";
    const rest = quiet ? context.argv.slice(1) : context.argv;
    const script = rest[0];
    if (script === undefined) return fail(context, "missing script", 2);

    const source = sourceFor(context, rest.slice(1));
    if (source === null) return result(nothing());

    const print = /^([0-9]+)(?:,([0-9]+))?p$/.exec(script);
    if (print !== null) {
      const from = Number(print[1]);
      const to = print[2] === undefined ? from : Number(print[2]);
      return result(printRange(source, from, to, quiet));
    }

    const substitute = parseSubstitution(script);
    if (substitute === null) {
      return fail(
        context,
        `only s/// and line-print scripts are supported, not '${script}'; ` +
          "run the container backend for anything else",
        2,
      );
    }
    return result(applySubstitution(source, substitute, quiet));
  } catch (error) {
    if (error instanceof UsageError || error instanceof PatternError) {
      return fail(context, error.message, 2);
    }
    throw error;
  }
};

interface Substitution {
  readonly pattern: RegExp;
  readonly replacement: string;
  readonly global: boolean;
}

function parseSubstitution(script: string): Substitution | null {
  if (!script.startsWith("s") || script.length < 4) return null;
  const delimiter = script.charAt(1);
  if (/[A-Za-z0-9\\\n]/.test(delimiter)) return null;

  const parts: string[] = [];
  let current = "";
  let index = 2;
  while (index < script.length && parts.length < 2) {
    const char = script.charAt(index);
    if (char === "\\" && script.charAt(index + 1) === delimiter) {
      current += delimiter;
      index += 2;
      continue;
    }
    if (char === delimiter) {
      parts.push(current);
      current = "";
      index++;
      continue;
    }
    current += char;
    index++;
  }
  if (parts.length < 2) return null;

  const flags = script.slice(index);
  if (!/^[gi]*$/.test(flags)) return null;
  const find = parts[0];
  const replace = parts[1];
  if (find === undefined || replace === undefined) return null;

  return {
    pattern: compilePattern(find, {
      dialect: "bre",
      ignoreCase: flags.includes("i"),
      wholeWord: false,
      wholeLine: false,
    }),
    // sed's `&` is the whole match; JS spells that `$&`.
    replacement: replace.replace(/\$/g, "$$$$").replace(/(^|[^\\])&/g, "$1$$&"),
    global: flags.includes("g"),
  };
}

function* applySubstitution(
  source: ByteStream,
  substitution: Substitution,
  quiet: boolean,
): ByteStream {
  const flags = substitution.global
    ? substitution.pattern.flags
    : substitution.pattern.flags.replace("g", "");
  const pattern = new RegExp(substitution.pattern.source, flags);
  for (const text of lines(source)) {
    const value = decode(text);
    const replaced = value.replace(pattern, substitution.replacement);
    if (quiet && replaced === value) continue;
    yield encode(`${replaced}\n`);
  }
}

function* printRange(source: ByteStream, from: number, to: number, quiet: boolean): ByteStream {
  let number = 0;
  for (const text of lines(source)) {
    number++;
    const inRange = number >= from && number <= to;
    // Without `-n`, sed prints every line and duplicates the range.
    if (!quiet) yield encode(`${decode(text)}\n`);
    if (inRange && quiet) yield encode(`${decode(text)}\n`);
    if (number > to && quiet) return;
  }
}

function sourceFor(
  context: Parameters<Command>[0],
  operands: readonly string[],
): ByteStream | null {
  if (operands.length === 0) return context.stdin;
  return (function* (): ByteStream {
    for (const operand of operands) {
      const path = resolve(context.cwd, operand);
      if (context.fs.stat(path) === null) {
        context.warn(`${operand}: No such file or directory`);
        continue;
      }
      yield context.fs.readFile(path);
    }
  })();
}

export const textCommands: ReadonlyMap<string, Command> = new Map([
  ["echo", echo],
  ["pwd", pwd],
  ["cd", cd],
  ["true", yes],
  ["false", no],
  ["which", which],
  ["sort", sort],
  ["uniq", uniq],
  ["sed", sed],
]);
