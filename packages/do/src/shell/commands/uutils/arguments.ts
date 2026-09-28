// Argv parsing the way the installed uutils binaries do it: clap with
// `infer_long_args`, so `--num` resolves to `--number`, an unknown flag names
// a similar one, and each failure prints clap's exact block on stderr. The
// parity gate compares those bytes, so the wording lives here once.

import { encode } from "../../exec/bytes.js";
import { jaro } from "./jaro.js";

export interface OptionSpec {
  /** Stable identity the command branches on. */
  readonly id: string;
  readonly short?: string;
  readonly long?: string;
  /** `none`: a switch; `required`: `-k 2`; `optional`: only `--check=silent`. */
  readonly value: "none" | "required" | "optional";
  /** How clap names the option in a diagnostic: `--key <key>`. */
  readonly display: string;
  /** Values clap accepts, when it validates them. */
  readonly possible?: readonly string[];
}

export interface CommandSpec {
  readonly name: string;
  readonly options: readonly OptionSpec[];
  /** Pairs clap rejects together, by id. */
  readonly conflicts?: ReadonlyArray<readonly [string, string]>;
}

export interface Occurrence {
  readonly id: string;
  readonly value: string | null;
}

export interface ParsedArguments {
  readonly occurrences: readonly Occurrence[];
  readonly operands: readonly string[];
}

export type ClapErrorKind =
  | "unknown-argument"
  | "unexpected-value"
  | "missing-value"
  | "invalid-value"
  | "conflict";

/** A clap usage failure: exact stderr bytes, and which kind picks the status. */
export class ClapError extends Error {
  readonly bytes: Uint8Array;

  constructor(
    readonly kind: ClapErrorKind,
    text: string,
  ) {
    super(text);
    this.name = "ClapError";
    this.bytes = encode(text);
  }
}

const MORE = "For more information, try '--help'.\n";

export function parseArguments(argv: readonly string[], spec: CommandSpec): ParsedArguments {
  const occurrences: Occurrence[] = [];
  const operands: string[] = [];
  const usage = `Usage: ${spec.name} [OPTION]... [FILE]...\n\n`;

  const unknown = (argument: string, tip: string): ClapError =>
    new ClapError(
      "unknown-argument",
      `error: unexpected argument '${argument}' found\n\n${tip}\n\n${usage}${MORE}`,
    );
  const missing = (option: OptionSpec): ClapError =>
    new ClapError(
      "missing-value",
      `error: a value is required for '${option.display}' but none was supplied\n\n${MORE}`,
    );
  const passAsValue = (argument: string): string =>
    `  tip: to pass '${argument}' as a value, use '-- ${argument}'`;

  let index = 0;
  const takeNext = (option: OptionSpec): string => {
    const next = argv[index + 1];
    if (next === undefined || (next.startsWith("-") && next !== "-")) throw missing(option);
    index++;
    return next;
  };
  const record = (option: OptionSpec, value: string | null): void => {
    if (value !== null && option.possible !== undefined && !option.possible.includes(value)) {
      throw new ClapError(
        "invalid-value",
        `error: invalid value '${value}' for '${option.display}'\n\n` +
          `  [possible values: ${option.possible.join(", ")}]\n\n${MORE}`,
      );
    }
    occurrences.push({ id: option.id, value });
  };

  for (; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      operands.push(...argv.slice(index + 1));
      break;
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = argument.slice(2, equals === -1 ? undefined : equals);
      const inline = equals === -1 ? null : argument.slice(equals + 1);
      const option = resolveLong(spec, name);
      if (option === null) {
        const similar = suggest(spec, name);
        throw unknown(
          `--${name}`,
          similar === null
            ? passAsValue(`--${name}`)
            : `tip: a similar argument exists: '--${similar}'`,
        );
      }
      if (option.value === "none") {
        if (inline !== null) {
          throw new ClapError(
            "unexpected-value",
            `error: unexpected value '${inline}' for '${option.display}' found; ` +
              `no more were expected\n\n${usage}${MORE}`,
          );
        }
        record(option, null);
      } else if (option.value === "optional") {
        record(option, inline);
      } else {
        record(option, inline ?? takeNext(option));
      }
      continue;
    }
    if (argument.startsWith("-") && argument.length > 1) {
      let cursor = 1;
      while (cursor < argument.length) {
        const letter = argument.charAt(cursor);
        const option = spec.options.find((candidate) => candidate.short === letter);
        if (option === undefined) throw unknown(`-${letter}`, passAsValue(`-${letter}`));
        cursor++;
        if (option.value === "none") {
          record(option, null);
          continue;
        }
        let rest = argument.slice(cursor);
        if (option.value === "optional") {
          // An optional value needs `=`: `-cu` is `-c -u`, `-c=silent` a value.
          if (!rest.startsWith("=")) {
            record(option, null);
            continue;
          }
          cursor = argument.length;
          record(option, rest.slice(1));
          continue;
        }
        if (rest.startsWith("=")) rest = rest.slice(1);
        cursor = argument.length;
        record(option, rest === "" ? takeNext(option) : rest);
      }
      continue;
    }
    operands.push(argument);
  }

  for (const [left, right] of spec.conflicts ?? []) {
    const leftAt = occurrences.findIndex((occurrence) => occurrence.id === left);
    const rightAt = occurrences.findIndex((occurrence) => occurrence.id === right);
    if (leftAt === -1 || rightAt === -1) continue;
    const [first, second] = leftAt < rightAt ? [left, right] : [right, left];
    throw new ClapError(
      "conflict",
      `error: the argument '${displayOf(spec, first)}' cannot be used with ` +
        `'${displayOf(spec, second)}'\n\n${MORE}`,
    );
  }
  return { occurrences, operands };
}

function resolveLong(spec: CommandSpec, name: string): OptionSpec | null {
  const exact = spec.options.find((option) => option.long === name);
  if (exact !== undefined) return exact;
  if (name === "") return null;
  const prefixed = spec.options.filter((option) => option.long?.startsWith(name) === true);
  return prefixed.length === 1 ? (prefixed[0] ?? null) : null;
}

/** clap's `did_you_mean`: the most similar long name above 0.7, the later one on a tie. */
function suggest(spec: CommandSpec, name: string): string | null {
  let best: { confidence: number; long: string } | null = null;
  for (const option of spec.options) {
    if (option.long === undefined) continue;
    const confidence = jaro(name, option.long);
    if (confidence <= 0.7) continue;
    if (best === null || confidence >= best.confidence) best = { confidence, long: option.long };
  }
  return best?.long ?? null;
}

function displayOf(spec: CommandSpec, id: string): string {
  return spec.options.find((option) => option.id === id)?.display ?? id;
}

export function has(parsed: ParsedArguments, id: string): boolean {
  return parsed.occurrences.some((occurrence) => occurrence.id === id);
}
