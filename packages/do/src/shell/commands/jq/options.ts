// jq's command line (main() in src/main.c): options may follow the filter,
// short options bundle, the last output-format option wins, and an unknown
// option prints jq's usage hint and exits 2. Options jq has but this shell
// does not implement are refused by name.

import type { DumpOptions } from "./dump.js";
import { parseJsonText } from "./json-parse.js";
import type { JqValue } from "./value.js";

export class OptionError extends Error {
  constructor(
    message: string,
    readonly usage: boolean,
  ) {
    super(message);
    this.name = "OptionError";
  }
}

export interface Options {
  readonly program: string;
  readonly files: readonly string[];
  readonly rawOutput: boolean;
  readonly join: boolean;
  /** `--raw-output0`: a NUL after each output instead of a newline. */
  readonly nul: boolean;
  readonly nullInput: boolean;
  readonly slurp: boolean;
  readonly rawInput: boolean;
  readonly exitStatus: boolean;
  readonly dump: DumpOptions;
  readonly named: ReadonlyMap<string, JqValue>;
  readonly positional: readonly JqValue[];
}

const SHORT = new Map([
  ["s", "slurp"],
  ["r", "raw-output"],
  ["j", "join-output"],
  ["c", "compact-output"],
  ["n", "null-input"],
  ["a", "ascii-output"],
  ["S", "sort-keys"],
  ["R", "raw-input"],
  ["e", "exit-status"],
  ["M", "monochrome-output"],
  ["C", "color-output"],
  ["f", "from-file"],
  ["L", "library-path"],
  ["b", "binary"],
  ["h", "help"],
  ["V", "version"],
]);

const REFUSED = new Set([
  "color-output",
  "from-file",
  "library-path",
  "binary",
  "help",
  "version",
  "unbuffered",
  "seq",
  "stream",
  "stream-errors",
  "rawfile",
  "slurpfile",
  "debug-dump-disasm",
  "debug-trace",
  "debug-trace=all",
  "build-configuration",
  "run-tests",
]);

export function parseOptions(argv: readonly string[]): Options {
  let program: string | null = null;
  const files: string[] = [];
  const named = new Map<string, JqValue>();
  const positional: JqValue[] = [];
  const flags = new Set<string>();
  let dump = { pretty: true, indent: 2, tab: false };
  let rest: "files" | "strings" | "json" = "files";
  let done = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (done || !isOptionish(arg)) {
      if (program === null) program = arg;
      else if (rest === "strings") positional.push(arg);
      else if (rest === "json") positional.push(parseArgument(arg, "--jsonargs"));
      else files.push(arg);
      continue;
    }
    if (arg === "--") {
      done = true;
      continue;
    }
    const longNames = arg.startsWith("--")
      ? [arg.slice(2)]
      : [...arg.slice(1)].map((letter) => {
          const name = SHORT.get(letter);
          if (name === undefined) throw new OptionError(`jq: Unknown option -${letter}`, true);
          return name;
        });
    for (const name of longNames) {
      if (REFUSED.has(name)) throw new OptionError(`jq: option --${name} is not supported`, false);
      switch (name) {
        case "compact-output":
          dump = { ...dump, pretty: false, indent: 0, tab: false };
          break;
        case "tab":
          dump = { pretty: true, indent: 0, tab: true };
          break;
        case "indent": {
          const value = argv[index + 1];
          if (value === undefined) throw new OptionError("jq: --indent takes one parameter", true);
          dump = indent(value);
          index++;
          break;
        }
        case "args":
          rest = "strings";
          break;
        case "jsonargs":
          rest = "json";
          break;
        case "arg":
        case "argjson": {
          const key = argv[index + 1];
          const value = argv[index + 2];
          if (key === undefined || value === undefined) {
            const example = name === "arg" ? "value" : "text";
            throw new OptionError(
              `jq: --${name} takes two parameters (e.g. --${name} varname ${example})`,
              true,
            );
          }
          if (!named.has(key))
            named.set(key, name === "arg" ? value : parseArgument(value, "--argjson"));
          index += 2;
          break;
        }
        case "raw-output0":
        case "slurp":
        case "raw-output":
        case "join-output":
        case "null-input":
        case "ascii-output":
        case "sort-keys":
        case "raw-input":
        case "exit-status":
        case "monochrome-output":
          flags.add(name);
          break;
        default:
          throw new OptionError(`jq: Unknown option --${name}`, true);
      }
    }
  }

  return {
    program: program ?? ".",
    files,
    rawOutput: flags.has("raw-output") || flags.has("join-output") || flags.has("raw-output0"),
    join: flags.has("join-output") || flags.has("raw-output0"),
    nul: flags.has("raw-output0"),
    nullInput: flags.has("null-input"),
    slurp: flags.has("slurp"),
    rawInput: flags.has("raw-input"),
    exitStatus: flags.has("exit-status"),
    dump: { ...dump, sortKeys: flags.has("sort-keys"), ascii: flags.has("ascii-output") },
    named,
    positional,
  };
}

/** isoptish: a dash followed by a dash or a letter. */
function isOptionish(arg: string): boolean {
  return arg.charAt(0) === "-" && (arg.charAt(1) === "-" || /^[A-Za-z]$/.test(arg.charAt(1)));
}

function indent(value: string): { pretty: boolean; indent: number; tab: boolean } {
  if (!/^[+-]?\d+$/.test(value))
    throw new OptionError("jq: --indent takes a number between -1 and 7", true);
  const width = Number(value);
  if (width < -1 || width > 7)
    throw new OptionError("jq: --indent takes a number between -1 and 7", true);
  return width === -1
    ? { pretty: true, indent: 0, tab: true }
    : { pretty: true, indent: width, tab: false };
}

function parseArgument(text: string, option: string): JqValue {
  const parsed = parseJsonText(text);
  if (parsed.kind === "error")
    throw new OptionError(`jq: invalid JSON text passed to ${option}`, true);
  return parsed.value;
}

export const USAGE_HINT =
  "Use jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.org\n";
