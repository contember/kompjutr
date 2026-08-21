// `xargs`.
//
// Most of the corpus's `xargs` lines are `find … | xargs grep`, which the
// planner's R2 collapses into one search before this ever runs. What is left
// is the tail R2 refuses to fuse — an `-n1`, an `-I{}`, a command that is
// not a search — and before this existed those lines died with "command not
// found", which is a worse answer than a slow one.
//
// So this is the deliberately unoptimised path: it materialises its input,
// groups it, and runs the command once per group through the `invoke` seam.
// Every sub-invocation shares the caller's `BoundedFs`, so the operation
// ceiling still bounds the whole thing however many groups there are.

import { type ByteStream, decode, drain } from "../exec/bytes.js";
import { type Command, fail } from "../exec/context.js";
import { count, UsageError } from "./flags.js";

/** GNU's exit code for "a command xargs ran failed". */
const CHILD_FAILED = 123;

export const xargs: Command = (context) => {
  try {
    // Flags are read by hand, and only until the first operand. The general
    // parser would keep going and swallow the *invoked* command's flags:
    // `xargs -n1 grep -c X` would have it reject `-c` as unknown, which is
    // exactly the shape R2 declines to fuse and this exists to run.
    const { options, rest } = leadingFlags(context.argv);

    let maxArgs: number | null = null;
    let replace: string | null = null;
    let delimiter: string | null = null;
    let nulSeparated = false;
    let skipWhenEmpty = false;

    for (const flag of options) {
      switch (flag.name) {
        case "-n":
        case "--max-args":
          maxArgs = count(flag.value ?? "", "-n");
          if (maxArgs === 0) throw new UsageError("-n must be at least 1");
          break;
        case "-I":
        case "--replace":
          replace = flag.value === null || flag.value === "" ? "{}" : flag.value;
          break;
        case "-d":
        case "--delimiter":
          delimiter = flag.value;
          break;
        case "-0":
        case "--null":
          nulSeparated = true;
          break;
        case "-r":
        case "--no-run-if-empty":
          skipWhenEmpty = true;
          break;
        case "-t":
        case "--verbose":
          break; // Nothing to echo the command to that is not stdout.
        default:
          throw new UsageError(`unrecognized option '${flag.name}'`);
      }
    }

    // `xargs` with no command runs `echo`, as GNU does.
    const [name = "echo", ...fixed] = rest;

    const input = context.stdin === null ? "" : decode(drain(context.stdin));
    // `-I` takes a whole line as one argument; everything else splits on
    // whitespace, so a path with a space in it needs `-0` to survive.
    const items = split(input, { replace: replace !== null, nulSeparated, delimiter });

    if (items.length === 0) {
      // GNU runs the command once with no arguments unless `-r`. `-I` never
      // runs on empty input, because there would be nothing to substitute.
      if (skipWhenEmpty || replace !== null) return { stdout: empty(), status: () => 0 };
      return runGroups(context, name, [fixed]);
    }

    if (replace !== null) {
      const marker = replace;
      return runGroups(
        context,
        name,
        items.map((item) => fixed.map((argument) => argument.split(marker).join(item))),
      );
    }

    const size = maxArgs ?? items.length;
    const groups: string[][] = [];
    for (let index = 0; index < items.length; index += size) {
      groups.push([...fixed, ...items.slice(index, index + size)]);
    }
    return runGroups(context, name, groups);
  } catch (error) {
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }
};

/**
 * Run one group after another, concatenating the output.
 *
 * Lazily, so a `xargs … | head -5` still stops after the group that
 * satisfies it rather than running every group first. The status follows
 * GNU: 123 when any invocation failed, and it is only valid once the stream
 * has been drained, because until then most of the groups have not run.
 */
function runGroups(
  context: Parameters<Command>[0],
  name: string,
  groups: ReadonlyArray<readonly string[]>,
): ReturnType<Command> {
  let status = 0;
  const stdout = (function* (): ByteStream {
    for (const argv of groups) {
      const produced = context.invoke(name, argv);
      if (produced === null) {
        context.warn(`${name}: command not found`);
        status = 127;
        return;
      }
      yield* produced.stdout;
      if (produced.status() !== 0) status = CHILD_FAILED;
    }
  })();
  return { stdout, status: () => status };
}

const VALUED = new Set(["-n", "-I", "-d", "--max-args", "--replace", "--delimiter"]);
const BOOLEAN = new Set(["-0", "-r", "-t", "--null", "--no-run-if-empty", "--verbose"]);

/** xargs's own flags, up to the command name. Everything after is the command's. */
function leadingFlags(argv: readonly string[]): {
  options: Array<{ name: string; value: string | null }>;
  rest: string[];
} {
  const options: Array<{ name: string; value: string | null }> = [];
  let index = 0;
  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      index++;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;

    const long = arg.startsWith("--");
    const equals = arg.indexOf("=");
    const name = long ? (equals === -1 ? arg : arg.slice(0, equals)) : arg.slice(0, 2);
    const inline = long ? (equals === -1 ? "" : arg.slice(equals + 1)) : arg.slice(2);

    if (VALUED.has(name)) {
      // `-I` alone means `-I{}`; every other valued flag needs its argument.
      if (inline !== "") {
        options.push({ name, value: inline });
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) {
        if (name === "-I" || name === "--replace") {
          options.push({ name, value: null });
          continue;
        }
        throw new UsageError(`option requires an argument -- ${name}`);
      }
      options.push({ name, value: next });
      index++;
      continue;
    }

    if (!BOOLEAN.has(name) || inline !== "") {
      throw new UsageError(`unrecognized option '${arg}'`);
    }
    options.push({ name, value: null });
  }
  return { options, rest: argv.slice(index) };
}

interface SplitOptions {
  readonly replace: boolean;
  readonly nulSeparated: boolean;
  readonly delimiter: string | null;
}

function split(input: string, options: SplitOptions): string[] {
  if (options.nulSeparated) return input.split("\0").filter((item) => item !== "");
  if (options.delimiter !== null) {
    return input.split(delimiterBytes(options.delimiter)).filter((item) => item !== "");
  }
  // `-I` is line-oriented: a path with a space is still one argument.
  if (options.replace) return input.split("\n").filter((item) => item !== "");
  return input.split(/\s+/).filter((item) => item !== "");
}

/** `-d '\n'` arrives as two characters, not one. */
function delimiterBytes(delimiter: string): string {
  if (delimiter === "\\n") return "\n";
  if (delimiter === "\\t") return "\t";
  if (delimiter === "\\0") return "\0";
  return delimiter;
}

function* empty(): ByteStream {
  // Nothing.
}
