// Argv parsing for the uutils members of this family (ln, rmdir, readlink,
// realpath), which parse with clap: options may follow operands, short flags
// bundle, and a long option may be abbreviated to any unique prefix.
//
// An unknown short flag and a missing operand reproduce clap's own
// diagnostic, which parity pins. An unknown or ambiguous long option is
// refused with our own usage error: clap would add a spelling suggestion
// whose choice we do not model. Options uutils has but this surface does not
// admit are refused by name, never ignored.

import { UsageError } from "../flags.js";

/** A clap usage failure: exact stderr bytes, no command prefix, status 1. */
export class ClapError extends Error {
  constructor(readonly text: string) {
    super(text);
    this.name = "ClapError";
  }
}

export interface OptionSpec {
  /** `Usage:` block exactly as clap prints it, without a trailing newline. */
  readonly usage: string;
  /** Short flag character to its canonical long name. */
  readonly short: ReadonlyMap<string, string>;
  /** Long name (without `--`) to whether it takes a value. */
  readonly long: ReadonlyMap<string, boolean>;
  /** Canonical names uutils accepts and this surface refuses. */
  readonly refused: ReadonlySet<string>;
}

export interface ParsedOptions {
  /** Canonical long names of boolean flags, in argv order. */
  readonly flags: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly operands: readonly string[];
}

export function parseOptions(argv: readonly string[], spec: OptionSpec): ParsedOptions {
  const flags: string[] = [];
  const values = new Map<string, string>();
  const operands: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      operands.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const spelled = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      const name = longName(spelled, arg, spec);
      if (spec.refused.has(name)) throw new UsageError(`--${name} is not supported`);
      if (spec.long.get(name) === true) {
        if (equals !== -1) {
          values.set(name, arg.slice(equals + 1));
          continue;
        }
        const value = argv[index + 1];
        if (value === undefined) throw new UsageError(`option '--${name}' requires an argument`);
        values.set(name, value);
        index++;
        continue;
      }
      if (equals !== -1) throw new UsageError(`option '--${name}' doesn't allow an argument`);
      flags.push(name);
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      for (const char of arg.slice(1)) {
        const name = spec.short.get(char);
        if (name === undefined) throw new ClapError(unexpectedArgument(`-${char}`, spec.usage));
        if (spec.refused.has(name)) throw new UsageError(`-${char} is not supported`);
        flags.push(name);
      }
      continue;
    }

    operands.push(arg);
  }

  return { flags, values, operands };
}

function longName(spelled: string, arg: string, spec: OptionSpec): string {
  if (spec.long.has(spelled)) return spelled;
  const candidates = [...spec.long.keys()].filter((name) => name.startsWith(spelled));
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (spelled === "" || only === undefined) throw new UsageError(`unrecognized option '${arg}'`);
  return only;
}

function unexpectedArgument(spelling: string, usage: string): string {
  return (
    `error: unexpected argument '${spelling}' found\n\n` +
    `  tip: to pass '${spelling}' as a value, use '-- ${spelling}'\n\n` +
    `${usage}\n\nFor more information, try '--help'.\n`
  );
}

/** clap's diagnostic for a required argument (`<files>...`, `--symbolic`) that is absent. */
export function missingRequired(argument: string, spec: OptionSpec): ClapError {
  return new ClapError(
    `error: the following required arguments were not provided:\n  ${argument}\n\n` +
      `${spec.usage}\n\nFor more information, try '--help'.\n`,
  );
}

export function has(parsed: ParsedOptions, ...names: readonly string[]): boolean {
  return parsed.flags.some((flag) => names.includes(flag));
}

/** The last of several mutually overriding flags, as clap resolves them. */
export function lastOf<T extends string>(parsed: ParsedOptions, names: readonly T[]): T | null {
  for (let index = parsed.flags.length - 1; index >= 0; index--) {
    const flag = parsed.flags[index];
    const found = names.find((name) => name === flag);
    if (found !== undefined) return found;
  }
  return null;
}
