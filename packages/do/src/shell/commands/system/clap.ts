// The argument parser uutils builds its commands on (clap), reduced to what
// these commands admit. The references print clap's own diagnostics, so the
// messages here are clap's bytes rather than the GNU `invalid option` shape
// the other surfaces use.

import { empty, encode } from "../../exec/bytes.js";
import { type CommandContext, type CommandResult, result } from "../../exec/context.js";

export interface OptionSpec {
  /** The canonical long name, without dashes. Messages name it. */
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly short?: readonly string[];
  /** `optional` reads an attached or following value; `equals` reads only `--name=VALUE`. */
  readonly value?: "required" | "optional" | "equals";
  /** The value placeholder clap prints: `--wrap <COLS>`. */
  readonly valueName?: string;
  readonly possible?: readonly string[];
  /** A second occurrence overrides the first instead of failing. */
  readonly repeatable?: boolean;
  /** A value may start with `-`, as `date -d -1` can. */
  readonly hyphenValues?: boolean;
  /** Printed instead of `--name`, for a short-only option such as mktemp's `-p <DIR>`. */
  readonly display?: string;
  /** A reference option this shell does not implement; naming it is refused. */
  readonly refused?: boolean;
}

export interface CommandSpec {
  readonly options: readonly OptionSpec[];
  /** The `Usage:` block of an unexpected-argument error, or null to omit it. */
  readonly usage: string | null;
  /** Whether a repeated-option error also prints the usage block. */
  readonly usageOnRepeat?: boolean;
  /** Options end at the first operand, as `env` needs for its command. */
  readonly stopAtFirstOperand?: boolean;
}

export interface Occurrence {
  readonly name: string;
  readonly value: string | null;
}

export interface ParsedCommandLine {
  readonly occurrences: readonly Occurrence[];
  readonly operands: readonly string[];
}

/** A reference option the shell refuses rather than ignores. */
export class RefusedOption extends Error {
  constructor(readonly option: string) {
    super(`option '${option}' is not supported`);
    this.name = "RefusedOption";
  }
}

/** A clap diagnostic, complete with its trailing newline. */
export class ClapError extends Error {
  constructor(readonly text: string) {
    super(text);
    this.name = "ClapError";
  }
}

/**
 * The failed result for a parse error, or null when `error` is something else.
 * `trailer` follows a clap diagnostic, as env's shebang hint does.
 */
export function parseFailure(
  context: CommandContext,
  error: unknown,
  status: number,
  trailer = "",
): CommandResult | null {
  if (error instanceof ClapError) {
    context.diagnostic(encode(`${error.text}${trailer}`));
    return result(empty(), status);
  }
  if (error instanceof RefusedOption) {
    context.warn(error.message);
    return result(empty(), status);
  }
  return null;
}

const MORE = "For more information, try '--help'.\n";

export function parseCommandLine(argv: readonly string[], spec: CommandSpec): ParsedCommandLine {
  const occurrences: Occurrence[] = [];
  const operands: string[] = [];
  const seen = new Set<string>();

  const record = (option: OptionSpec, value: string | null): void => {
    if (seen.has(option.name) && option.repeatable !== true) {
      const usage = spec.usageOnRepeat === true ? usageBlock(spec) : "";
      throw new ClapError(
        `error: the argument '${display(option)}' cannot be used multiple times\n\n${usage}${MORE}`,
      );
    }
    if (option.refused === true) {
      throw new RefusedOption(`--${option.name}`);
    }
    seen.add(option.name);
    if (value !== null && option.possible !== undefined && !option.possible.includes(value)) {
      throw new ClapError(
        `error: invalid value '${value}' for '${display(option)}'\n\n${possibleBlock(option)}${MORE}`,
      );
    }
    occurrences.push({ name: option.name, value });
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      operands.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      if (spec.stopAtFirstOperand === true) {
        operands.push(...argv.slice(index));
        break;
      }
      operands.push(arg);
      continue;
    }

    const next = (option: OptionSpec): string | null => {
      const candidate = argv[index + 1];
      if (candidate === undefined) return null;
      if (candidate.startsWith("-") && candidate !== "-" && option.hyphenValues !== true) {
        if (candidate === "--" || looksLikeOption(candidate, spec)) return null;
        throw unexpected(candidate, spec);
      }
      index++;
      return candidate;
    };

    // An optional value is taken from the next argument unless it looks like an option.
    const following = (): string | null => {
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith("-")) return null;
      index++;
      return candidate;
    };

    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const written = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      const option = findLong(written, spec);
      if (option === null) throw unexpected(equals === -1 ? arg : arg.slice(0, equals), spec);
      const inline = equals === -1 ? null : arg.slice(equals + 1);
      if (option.value === undefined) {
        if (inline !== null) {
          throw new ClapError(
            `error: unexpected value '${inline}' for '${display(option)}' found; no more were expected\n\n${MORE}`,
          );
        }
        record(option, null);
      } else if (option.value === "required") {
        const value = inline ?? next(option);
        if (value === null) throw missingValue(option);
        record(option, value);
      } else if (option.value === "optional") {
        record(option, inline ?? following());
      } else {
        record(option, inline);
      }
      continue;
    }

    let cursor = 1;
    while (cursor < arg.length) {
      const letter = arg.charAt(cursor);
      const option = findShort(letter, spec);
      if (option === null) throw unexpected(`-${letter}`, spec);
      cursor++;
      if (option.value === undefined) {
        record(option, null);
        continue;
      }
      const attached = arg.slice(cursor);
      const inline = attached.startsWith("=") ? attached.slice(1) : attached;
      cursor = arg.length;
      if (option.value === "required") {
        const value = inline !== "" ? inline : next(option);
        if (value === null) throw missingValue(option);
        record(option, value);
      } else if (option.value === "optional") {
        record(option, inline !== "" ? inline : following());
      } else {
        record(option, inline === "" ? null : inline);
      }
    }
  }

  return { occurrences, operands };
}

/** clap's error for an operand or option nothing accepts. */
export function unexpected(arg: string, spec: CommandSpec): ClapError {
  const tip = arg.startsWith("-") ? `  tip: to pass '${arg}' as a value, use '-- ${arg}'\n\n` : "";
  return new ClapError(
    `error: unexpected argument '${arg}' found\n\n${tip}${usageBlock(spec)}${MORE}`,
  );
}

/** clap's error for two options declared mutually exclusive. */
export function conflict(first: string, second: string): ClapError {
  return new ClapError(`error: the argument '${first}' cannot be used with '${second}'\n\n${MORE}`);
}

export function has(parsed: ParsedCommandLine, name: string): boolean {
  return parsed.occurrences.some((occurrence) => occurrence.name === name);
}

/** The value of the last occurrence, or undefined when the option is absent. */
export function last(parsed: ParsedCommandLine, name: string): string | null | undefined {
  let found: string | null | undefined;
  for (const occurrence of parsed.occurrences) {
    if (occurrence.name === name) found = occurrence.value;
  }
  return found;
}

function missingValue(option: OptionSpec): ClapError {
  return new ClapError(
    `error: a value is required for '${display(option)}' but none was supplied\n\n${possibleBlock(option)}${MORE}`,
  );
}

function usageBlock(spec: CommandSpec): string {
  return spec.usage === null ? "" : `Usage: ${spec.usage}\n\n`;
}

function possibleBlock(option: OptionSpec): string {
  return option.possible === undefined
    ? ""
    : `  [possible values: ${option.possible.join(", ")}]\n\n`;
}

function display(option: OptionSpec): string {
  if (option.display !== undefined) return option.display;
  const placeholder = option.valueName ?? "VALUE";
  switch (option.value) {
    case undefined:
      return `--${option.name}`;
    case "required":
      return `--${option.name} <${placeholder}>`;
    case "optional":
      return `--${option.name} [<${placeholder}>]`;
    case "equals":
      return `--${option.name}[=<${placeholder}>]`;
  }
}

/** Exact long names first, then a unique prefix, as uutils infers them. */
function findLong(written: string, spec: CommandSpec): OptionSpec | null {
  for (const option of spec.options) {
    if (option.name === written || option.aliases?.includes(written) === true) return option;
  }
  if (written === "") return null;
  const matches = spec.options.filter((option) =>
    [option.name, ...(option.aliases ?? [])].some((name) => name.startsWith(written)),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function findShort(letter: string, spec: CommandSpec): OptionSpec | null {
  return spec.options.find((option) => option.short?.includes(letter) === true) ?? null;
}

function looksLikeOption(arg: string, spec: CommandSpec): boolean {
  if (arg.startsWith("--")) {
    const equals = arg.indexOf("=");
    return findLong(equals === -1 ? arg.slice(2) : arg.slice(2, equals), spec) !== null;
  }
  return findShort(arg.charAt(1), spec) !== null;
}
