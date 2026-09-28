// The argv grammar of the uutils tools (cut, tr, nl, comm, seq), which parse
// with clap: unique long-option prefixes, `-f1`/`-f=1`/`-f 1`, and a value
// that starts with `-` only where the option allows it. A clap failure is a
// multi-line diagnostic with status 1, reproduced byte for byte because the
// parity reference prints it.

export interface ClapOption {
  readonly id: string;
  readonly long?: string;
  readonly short?: string;
  /** The value name shown in diagnostics; absent for a flag. */
  readonly value?: string;
  /** `-f -1`: the next argument is a value even when it starts with `-`. */
  readonly hyphenValues?: boolean;
  /** Clap rejects a second occurrence unless the command lets it override. */
  readonly repeatable?: boolean;
  /** A fixed set of values, listed when one is missing or wrong. */
  readonly choices?: readonly string[];
  /** A typed value parser: the reason it rejects, and the value as clap shows it. */
  readonly parse?: (value: string) => { readonly reason: string; readonly shown: string } | null;
}

export interface ClapCommand {
  readonly name: string;
  /** Everything after `Usage: `, continuation lines already indented. */
  readonly usage: string;
  readonly options: readonly ClapOption[];
  /** tr and seq: after the first operand every argument is an operand. */
  readonly trailingOperands?: boolean;
  /** seq: an argument that is not a known option is an operand (`-1`). */
  readonly hyphenOperands?: boolean;
}

export interface ClapMatch {
  readonly id: string;
  readonly value: string | null;
}

export interface ClapParsed {
  readonly matches: readonly ClapMatch[];
  readonly operands: readonly string[];
}

/** A diagnostic already rendered to its final bytes. Status is always 1. */
export class ClapError extends Error {
  constructor(readonly rendered: string) {
    super(rendered);
    this.name = "ClapError";
  }
}

const HELP_SUGGESTION = "For more information, try '--help'.\n";
const HELP: ClapOption = { id: "help", long: "help", short: "h" };
const VERSION: ClapOption = { id: "version", long: "version", short: "V" };

/** Clap adds `--help`/`-h` and `--version`/`-V` unless the tool claims the letter. */
export function withBuiltins(options: readonly ClapOption[]): ClapOption[] {
  const shorts = new Set(options.map((option) => option.short));
  const longs = new Set(options.map((option) => option.long));
  const builtins = [HELP, VERSION]
    .filter((builtin) => !longs.has(builtin.long))
    .map((builtin) =>
      shorts.has(builtin.short) ? { id: builtin.id, long: builtin.long } : builtin,
    );
  return [...options, ...builtins];
}

export function parseClap(command: ClapCommand, argv: readonly string[]): ClapParsed {
  const matches: ClapMatch[] = [];
  const operands: string[] = [];
  const seen = new Set<string>();
  const record = (option: ClapOption, value: string | null): void => {
    if (seen.has(option.id) && option.repeatable !== true) {
      throw new ClapError(
        `error: the argument '${display(option)}' cannot be used multiple times\n\n${HELP_SUGGESTION}`,
      );
    }
    seen.add(option.id);
    if (value !== null) validate(option, value);
    matches.push({ id: option.id, value });
  };
  // A value that looks like an option leaves the option pending: clap parses
  // that argument first, so an unknown one is what gets reported.
  let pending: ClapOption | null = null;
  const takeValue = (option: ClapOption, index: number): number => {
    const next = argv[index + 1];
    if (next === undefined) throw valueRequired(option);
    if (looksLikeOption(next) && option.hyphenValues !== true) {
      pending = option;
      return index;
    }
    record(option, next);
    return index + 1;
  };
  let escaped = false;

  /** Consumes the argument at `index` and any value it takes; returns the last index used. */
  const step = (index: number): number => {
    const arg = argv[index] ?? "";
    if (escaped || (command.trailingOperands === true && operands.length > 0)) {
      operands.push(arg);
      return index;
    }
    if (arg === "--") {
      escaped = true;
      return index;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = arg.slice(2, equals === -1 ? undefined : equals);
      const option = findLong(command.options, name);
      if (option === null) {
        if (command.hyphenOperands !== true) throw unexpectedLong(command, name);
        operands.push(arg);
        return index;
      }
      if (option.value === undefined && equals !== -1) {
        throw new ClapError(
          `error: unexpected value '${arg.slice(equals + 1)}' for '--${option.long ?? name}' found; no more were expected\n\n${usageBlock(command)}`,
        );
      }
      if (option.value === undefined) {
        record(option, null);
        return index;
      }
      if (equals !== -1) {
        record(option, arg.slice(equals + 1));
        return index;
      }
      return takeValue(option, index);
    }
    if (!looksLikeOption(arg)) {
      operands.push(arg);
      return index;
    }
    const letters = arg.slice(1);
    if (command.hyphenOperands === true && !allShorts(command.options, letters)) {
      operands.push(arg);
      return index;
    }
    for (let cursor = 0; cursor < letters.length; cursor++) {
      const letter = letters.charAt(cursor);
      const option = command.options.find((candidate) => candidate.short === letter);
      if (option === undefined) throw unexpectedShort(command, letter);
      if (option.value === undefined) {
        record(option, null);
        continue;
      }
      const attached = letters.slice(cursor + 1);
      if (attached === "") return takeValue(option, index);
      record(option, attached.startsWith("=") ? attached.slice(1) : attached);
      return index;
    }
    return index;
  };

  for (let index = 0; index < argv.length; index++) {
    const waiting: ClapOption | null = pending;
    pending = null;
    if (waiting !== null && argv[index] === "--") throw valueRequired(waiting);
    index = step(index);
    if (waiting !== null) throw valueRequired(waiting);
  }
  if (pending !== null) throw valueRequired(pending);
  return { matches, operands };
}

function validate(option: ClapOption, value: string): void {
  if (value === "" && (option.choices !== undefined || option.parse !== undefined)) {
    throw valueRequired(option);
  }
  if (option.choices !== undefined && !option.choices.includes(value)) {
    throw invalidChoice(option, value, option.choices);
  }
  const rejected = option.parse?.(value) ?? null;
  if (rejected !== null) throw invalidValue(option, rejected.shown, rejected.reason);
}

export function has(parsed: ClapParsed, id: string): boolean {
  return parsed.matches.some((match) => match.id === id);
}

/** The last value given for an option, as clap's overriding options keep. */
export function last(parsed: ClapParsed, id: string): string | null {
  let found: string | null = null;
  for (const match of parsed.matches) if (match.id === id) found = match.value;
  return found;
}

export function display(option: ClapOption): string {
  const name = option.long === undefined ? `-${option.short ?? ""}` : `--${option.long}`;
  return option.value === undefined ? name : `${name} <${option.value}>`;
}

export function usageBlock(command: ClapCommand): string {
  return `Usage: ${command.usage}\n\n${HELP_SUGGESTION}`;
}

export function valueRequired(option: ClapOption): ClapError {
  const choices =
    option.choices === undefined ? "" : `  [possible values: ${option.choices.join(", ")}]\n\n`;
  return new ClapError(
    `error: a value is required for '${display(option)}' but none was supplied\n\n${choices}${HELP_SUGGESTION}`,
  );
}

/** A value parser's rejection: `nl -w abc`. */
export function invalidValue(option: ClapOption, value: string, reason: string): ClapError {
  return new ClapError(
    `error: invalid value '${value}' for '${display(option)}': ${reason}\n\n${HELP_SUGGESTION}`,
  );
}

/** A value outside a fixed set: `nl -n xx`. */
export function invalidChoice(
  option: ClapOption,
  value: string,
  choices: readonly string[],
): ClapError {
  return new ClapError(
    `error: invalid value '${value}' for '${display(option)}'\n\n  [possible values: ${choices.join(", ")}]\n\n${HELP_SUGGESTION}`,
  );
}

export function unexpectedOperand(command: ClapCommand, operand: string): ClapError {
  return new ClapError(`error: unexpected argument '${operand}' found\n\n${usageBlock(command)}`);
}

export function conflict(first: ClapOption, second: ClapOption): ClapError {
  return new ClapError(
    `error: the argument '${display(first)}' cannot be used with '${display(second)}'\n\n${HELP_SUGGESTION}`,
  );
}

function looksLikeOption(arg: string): boolean {
  return arg.startsWith("-") && arg.length > 1;
}

function findLong(options: readonly ClapOption[], name: string): ClapOption | null {
  const exact = options.find((option) => option.long === name);
  if (exact !== undefined) return exact;
  if (name === "") return null;
  const prefixed = options.filter((option) => option.long?.startsWith(name) === true);
  return prefixed.length === 1 ? (prefixed[0] ?? null) : null;
}

function allShorts(options: readonly ClapOption[], letters: string): boolean {
  for (const letter of letters) {
    if (!options.some((option) => option.short === letter)) return false;
  }
  return true;
}

function unexpectedShort(command: ClapCommand, letter: string): ClapError {
  const arg = `-${letter}`;
  return new ClapError(
    `error: unexpected argument '${arg}' found\n\n  tip: to pass '${arg}' as a value, use '-- ${arg}'\n\n${usageBlock(command)}`,
  );
}

function unexpectedLong(command: ClapCommand, name: string): ClapError {
  const arg = `--${name}`;
  const suggestion = suggest(command.options, name);
  const tip =
    suggestion === null
      ? `  tip: to pass '${arg}' as a value, use '-- ${arg}'`
      : `tip: a similar argument exists: '--${suggestion}'`;
  return new ClapError(
    `error: unexpected argument '${arg}' found\n\n${tip}\n\n${usageBlock(command)}`,
  );
}

/** Clap's did-you-mean: the most Jaro-similar long name above 0.7, ties to the last. */
function suggest(options: readonly ClapOption[], name: string): string | null {
  let best: { name: string; confidence: number } | null = null;
  for (const option of options) {
    if (option.long === undefined) continue;
    const confidence = jaro(name, option.long);
    if (confidence <= 0.7) continue;
    if (best === null || confidence >= best.confidence) best = { name: option.long, confidence };
  }
  return best?.name ?? null;
}

/** strsim's Jaro similarity over Unicode scalar values. */
function jaro(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aFlags = new Array<boolean>(a.length).fill(false);
  const bFlags = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const low = Math.max(0, i - range);
    const high = Math.min(i + range, b.length - 1);
    for (let j = low; j <= high; j++) {
      if (bFlags[j] === true || a[i] !== b[j]) continue;
      aFlags[i] = true;
      bFlags[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    if (aFlags[i] !== true) continue;
    while (bFlags[j] !== true) j++;
    if (a[i] !== b[j]) transpositions++;
    j++;
  }
  transpositions = Math.floor(transpositions / 2);
  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}
