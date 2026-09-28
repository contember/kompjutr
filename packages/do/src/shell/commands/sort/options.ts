// `sort`'s option surface, as uutils sort 0.2.2 spells and rejects it.
// Orderings that need a locale, randomness, or an external merge (`-g`,
// `-M`, `-R`, `-i`, `-m`, …) are refused rather than approximated.

import { UsageError } from "../flags.js";
import {
  type CommandSpec,
  has,
  type OptionSpec,
  type ParsedArguments,
  parseArguments,
} from "../uutils/arguments.js";
import { DEFAULT_OPTIONS, type KeyOptions, parseKey, type SortKey } from "./keys.js";

const flag = (id: string, short: string | undefined, long: string): OptionSpec => ({
  id,
  ...(short === undefined ? {} : { short }),
  long,
  value: "none",
  display: `--${long}`,
});

const valued = (id: string, short: string | undefined, long: string, name: string): OptionSpec => ({
  id,
  ...(short === undefined ? {} : { short }),
  long,
  value: "required",
  display: `--${long} <${name}>`,
});

// Definition order matters: clap breaks a suggestion tie toward the later name.
const SPEC: CommandSpec = {
  name: "sort",
  options: [
    flag("help", undefined, "help"),
    flag("version", undefined, "version"),
    valued("sort", undefined, "sort", "sort"),
    flag("h", "h", "human-numeric-sort"),
    flag("M", "M", "month-sort"),
    flag("n", "n", "numeric-sort"),
    flag("g", "g", "general-numeric-sort"),
    flag("V", "V", "version-sort"),
    flag("R", "R", "random-sort"),
    flag("d", "d", "dictionary-order"),
    flag("m", "m", "merge"),
    {
      id: "c",
      short: "c",
      long: "check",
      value: "optional",
      display: "--check[=<check>...]",
      possible: ["silent", "quiet", "diagnose-first"],
    },
    flag("C", "C", "check-silent"),
    flag("f", "f", "ignore-case"),
    flag("i", "i", "ignore-nonprinting"),
    flag("b", "b", "ignore-leading-blanks"),
    valued("o", "o", "output", "FILENAME"),
    flag("r", "r", "reverse"),
    flag("s", "s", "stable"),
    flag("u", "u", "unique"),
    valued("k", "k", "key", "key"),
    valued("t", "t", "field-separator", "field-separator"),
    flag("z", "z", "zero-terminated"),
    valued("parallel", undefined, "parallel", "NUM_THREADS"),
    valued("S", "S", "buffer-size", "SIZE"),
    valued("T", "T", "temporary-directory", "DIR"),
    valued("compress-program", undefined, "compress-program", "PROG"),
    valued("batch-size", undefined, "batch-size", "N_MERGE"),
    valued("files0-from", undefined, "files0-from", "NUL_FILE"),
    flag("debug", undefined, "debug"),
  ],
  conflicts: [
    ["n", "V"],
    ["n", "d"],
    ["n", "h"],
    ["h", "V"],
    ["d", "h"],
    ["c", "C"],
    ["c", "o"],
    ["C", "o"],
  ],
};

const REFUSED = [
  "help",
  "version",
  "sort",
  "M",
  "g",
  "R",
  "m",
  "i",
  "parallel",
  "S",
  "T",
  "compress-program",
  "batch-size",
  "files0-from",
  "debug",
];

export interface SortSettings {
  readonly global: KeyOptions;
  readonly keys: readonly SortKey[];
  readonly unique: boolean;
  readonly stable: boolean;
  readonly check: "none" | "diagnose" | "silent";
  /** The `-t` byte; null splits fields at blank runs. */
  readonly separator: number | null;
  /** The record delimiter: newline, or NUL under `-z`. */
  readonly delimiter: number;
  readonly output: string | null;
  readonly operands: readonly string[];
}

/** A uutils usage failure that it follows with a `--help` hint. */
export class SortUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SortUsageError";
  }
}

/** A uutils failure it reports without a hint, status 2. */
export class PlainSortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlainSortError";
  }
}

/** Throws `ClapError`, `PlainSortError`, `KeyError`, `SortUsageError`, or `UsageError` for a refusal. */
export function parseSortArguments(argv: readonly string[]): SortSettings {
  const parsed = parseArguments(argv, SPEC);
  for (const id of REFUSED) {
    if (!has(parsed, id)) continue;
    const option = SPEC.options.find((candidate) => candidate.id === id);
    const spelling = option?.short === undefined ? `--${option?.long ?? id}` : `-${option.short}`;
    throw new UsageError(`${spelling} is not supported`);
  }

  const values = (id: string): string[] =>
    parsed.occurrences.flatMap((occurrence) =>
      occurrence.id === id && occurrence.value !== null ? [occurrence.value] : [],
    );
  const outputs = values("o");
  if (outputs.length > 1) throw new PlainSortError("multiple output files specified");

  const separators = values("t");
  const separator = separators.at(-1);
  if (separator !== undefined && new TextEncoder().encode(separator).length !== 1) {
    throw new SortUsageError(`separator must be exactly one character long: '${separator}'`);
  }

  const global = globalOptions(parsed);
  const keys = values("k").map((text) => parseKey(text, global));

  const check = checkMode(parsed);
  const operands = parsed.operands;
  const extra = operands[1];
  if (check !== "none" && extra !== undefined) {
    throw new SortUsageError(`extra operand '${extra}' not allowed with -c`);
  }

  return {
    global,
    keys,
    unique: has(parsed, "u"),
    stable: has(parsed, "s"),
    check,
    separator: separator === undefined ? null : separator.charCodeAt(0),
    delimiter: has(parsed, "z") ? 0x00 : 0x0a,
    output: outputs[0] ?? null,
    operands,
  };
}

function globalOptions(parsed: ParsedArguments): KeyOptions {
  const blanks = has(parsed, "b");
  return {
    ...DEFAULT_OPTIONS,
    blanksAtStart: blanks,
    blanksAtEnd: blanks,
    dictionary: has(parsed, "d"),
    fold: has(parsed, "f"),
    mode: has(parsed, "n")
      ? "numeric"
      : has(parsed, "h")
        ? "human"
        : has(parsed, "V")
          ? "version"
          : "text",
    reverse: has(parsed, "r"),
  };
}

function checkMode(parsed: ParsedArguments): SortSettings["check"] {
  let mode: SortSettings["check"] = "none";
  for (const occurrence of parsed.occurrences) {
    if (occurrence.id === "C") mode = "silent";
    if (occurrence.id !== "c") continue;
    mode = occurrence.value === "silent" || occurrence.value === "quiet" ? "silent" : "diagnose";
  }
  return mode;
}
