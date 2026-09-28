// Bash's `type` and `command -v`/`-V`, over the registry (see known.ts).
// Both follow Bash 5.2's `describe_command`: the last of -t/-p/-P wins, -P
// keeps forcing a file lookup, and only the verbose forms report a missing
// name. `type -a` and `command -p` enumerate the host PATH and are refused;
// so is `command NAME ARGS`, which would run NAME with `command`'s stdin and
// diagnostics rather than its own.

import { type ByteStream, encode } from "../../exec/bytes.js";
import { type Command, type CommandContext, result } from "../../exec/context.js";
import { UsageError } from "../flags.js";
import { resolveName } from "./known.js";

interface Describe {
  /** `-t`: print only the kind. */
  readonly type: boolean;
  /** `-p`/`-P`: print only a file's path. */
  readonly pathOnly: boolean;
  /** `-P`: skip keywords and builtins. */
  readonly forcePath: boolean;
  /** `command -v`: print what would run, reusable as input. */
  readonly reusable: boolean;
}

export const type: Command = (context) => {
  const legacy: ReadonlyMap<string, string> = new Map([
    ["-type", "-t"],
    ["--type", "-t"],
    ["-path", "-p"],
    ["--path", "-p"],
    ["-all", "-a"],
    ["--all", "-a"],
  ]);
  const argv = context.argv.map((argument) => legacy.get(argument) ?? argument);
  const parsed = builtinOptions(argv, "afptP");
  if (typeof parsed === "string") {
    return usage(context, "type", parsed, "type [-afptP] name [name ...]");
  }
  let describe: Describe = { type: false, pathOnly: false, forcePath: false, reusable: false };
  for (const letter of parsed.letters) {
    if (letter === "a") throw new UsageError("-a is not supported: there is no PATH to search");
    if (letter === "p") describe = { ...describe, pathOnly: true, type: false };
    if (letter === "t") describe = { ...describe, type: true, pathOnly: false };
    if (letter === "P") describe = { ...describe, pathOnly: true, forcePath: true, type: false };
  }
  const verbose = !describe.type && !describe.pathOnly;
  let missing = false;
  const stream = (function* (): ByteStream {
    for (const name of parsed.names) {
      const line = describeName(name, describe);
      if (line === false) {
        missing = true;
        if (verbose) notFound(context, "type", name);
        continue;
      }
      if (line !== null) yield encode(`${line}\n`);
    }
  })();
  return { stdout: stream, status: () => (missing ? 1 : 0), truncated: () => false };
};

export const command: Command = (context) => {
  const parsed = builtinOptions(context.argv, "pvV");
  if (typeof parsed === "string") {
    return usage(context, "command", parsed, "command [-pVv] command [arg ...]");
  }
  let mode: "run" | "reusable" | "verbose" = "run";
  for (const letter of parsed.letters) {
    if (letter === "p") throw new UsageError("-p is not supported: there is no PATH to search");
    mode = letter === "v" ? "reusable" : "verbose";
  }
  const first = parsed.names[0];
  if (mode === "run") {
    if (first === undefined) return result((function* (): ByteStream {})());
    throw new UsageError(
      `running ${first} through command is not supported; run ${first} directly`,
    );
  }
  const describe: Describe = {
    type: false,
    pathOnly: false,
    forcePath: false,
    reusable: mode === "reusable",
  };
  let found = parsed.names.length === 0;
  const stream = (function* (): ByteStream {
    for (const name of parsed.names) {
      const line = describeName(name, describe);
      if (line === false) {
        if (mode === "verbose") notFound(context, "command", name);
        continue;
      }
      found = true;
      if (line !== null) yield encode(`${line}\n`);
    }
  })();
  return { stdout: stream, status: () => (found ? 0 : 1), truncated: () => false };
};

/** The line to print, null when found but silent (`type -p cd`), false when not found. */
function describeName(name: string, describe: Describe): string | null | false {
  const found = resolveName(name, describe.forcePath);
  if (found === null) return false;
  if (describe.type) return found.kind;
  if (found.kind === "file") {
    return describe.pathOnly || describe.reusable ? found.path : `${name} is ${found.path}`;
  }
  if (describe.pathOnly) return null;
  if (describe.reusable) return name;
  return `${name} is a shell ${found.kind}`;
}

/** Bash's `internal_getopt`: leading `-xyz` words until `--` or a non-option. */
function builtinOptions(
  argv: readonly string[],
  allowed: string,
): { letters: string[]; names: readonly string[] } | string {
  const letters: string[] = [];
  let index = 0;
  for (; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    if (argument === "--") {
      index++;
      break;
    }
    if (!argument.startsWith("-") || argument === "-") break;
    for (const letter of argument.slice(1)) {
      if (!allowed.includes(letter)) return `-${letter}`;
      letters.push(letter);
    }
  }
  return { letters, names: argv.slice(index) };
}

function notFound(context: CommandContext, builtin: string, name: string): void {
  context.diagnostic(encode(`bash: line ${context.line}: ${builtin}: ${name}: not found\n`));
}

function usage(
  context: CommandContext,
  builtin: string,
  option: string,
  synopsis: string,
): ReturnType<Command> {
  context.diagnostic(
    encode(
      `bash: line ${context.line}: ${builtin}: ${option}: invalid option\n` +
        `${builtin}: usage: ${synopsis}\n`,
    ),
  );
  return result((function* (): ByteStream {})(), 2);
}
