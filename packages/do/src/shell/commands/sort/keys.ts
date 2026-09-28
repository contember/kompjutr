// `sort -k KEYDEF` parsing and field extraction.
//
// Parsing follows uutils sort 0.2.2, whose diagnostics the parity suite pins.
// Extraction follows POSIX `sort -k`:
// without `-t` a field starts at the blanks before it, and with `-t` the
// separator belongs to neither neighbour.

import { UsageError } from "../flags.js";

export type SortMode = "text" | "numeric" | "human" | "version";

export interface KeyOptions {
  readonly blanksAtStart: boolean;
  readonly blanksAtEnd: boolean;
  readonly dictionary: boolean;
  readonly fold: boolean;
  readonly mode: SortMode;
  readonly reverse: boolean;
}

export interface SortKey {
  /** Zero-based. */
  readonly startField: number;
  /** Zero-based offset into the start field. */
  readonly startChar: number;
  /** Zero-based; null runs the key to the end of the line. */
  readonly endField: number | null;
  /** One-based last byte of the end field; 0 is the end of that field. */
  readonly endChar: number;
  readonly options: KeyOptions;
}

export const DEFAULT_OPTIONS: KeyOptions = {
  blanksAtStart: false,
  blanksAtEnd: false,
  dictionary: false,
  fold: false,
  mode: "text",
  reverse: false,
};

/** A key uutils rejects, with its exact diagnostic, status 2. */
export class KeyError extends Error {
  constructor(key: string, reason: string) {
    super(`failed to parse key '${key}': ${reason}`);
    this.name = "KeyError";
  }
}

const OPTION_LETTERS = "bdfgiMhnRrV";
const MODE_LETTERS: ReadonlyMap<string, SortMode> = new Map([
  ["n", "numeric"],
  ["h", "human"],
  ["V", "version"],
]);
const REFUSED_LETTERS = new Set(["g", "i", "M", "R"]);

/** Parse one KEYDEF. Without its own ordering options, a key takes the global ones. */
export function parseKey(text: string, global: KeyOptions): SortKey {
  const parts = text.split(",");
  if (parts.length > 2) throw new UsageError(`key '${text}': a third position is not supported`);

  const start = splitPosition(text, parts[0] ?? "");
  const startField = fieldIndex(text, start.field);
  let startChar = 0;
  if (start.char !== null) {
    const parsed = characterIndex(text, start.char);
    if (parsed === 0) {
      throw new KeyError(text, "invalid character index 0 for the start position of a field");
    }
    startChar = parsed - 1;
  }

  const end = parts[1] === undefined ? null : splitPosition(text, parts[1]);
  let endField: number | null = null;
  let endChar = 0;
  if (end !== null) {
    endField = fieldIndex(text, end.field);
    if (end.char !== null) endChar = characterIndex(text, end.char);
  }

  if (start.extra || end?.extra === true) {
    throw new UsageError(`key '${text}': more than FIELD.CHAR in a position is not supported`);
  }
  const endOptions = end?.options ?? [];
  const options =
    start.options.length === 0 && endOptions.length === 0
      ? global
      : keyOptions(text, start.options, endOptions);
  return { startField, startChar, endField, endChar, options };
}

interface Position {
  readonly field: string;
  readonly char: string | null;
  readonly extra: boolean;
  readonly options: readonly string[];
}

// uutils splits a position at its first alphabetic character and parses
// each number as a Rust `usize`, whose error texts the diagnostics carry.
function splitPosition(key: string, spelling: string): Position {
  const optionsAt = spelling.search(/\p{Alphabetic}/u);
  const numeric = optionsAt === -1 ? spelling : spelling.slice(0, optionsAt);
  const options = Array.from(optionsAt === -1 ? "" : spelling.slice(optionsAt));
  for (const letter of options) {
    if (!OPTION_LETTERS.includes(letter)) throw new KeyError(key, `invalid option: '${letter}'`);
  }
  const [field = "", char, ...rest] = numeric.split(".");
  return { field, char: char ?? null, extra: rest.length > 0, options };
}

function fieldIndex(key: string, digits: string): number {
  const problem = usizeProblem(digits);
  // An overflowing field index is accepted: no line has that many fields.
  if (problem !== null && problem !== OVERFLOW) {
    throw new KeyError(key, `failed to parse field index '${digits}' ${problem}`);
  }
  const field = Number(digits);
  if (field === 0) throw new KeyError(key, "field index can not be 0");
  return field - 1;
}

function characterIndex(key: string, digits: string): number {
  const problem = usizeProblem(digits);
  if (problem !== null) {
    throw new KeyError(key, `failed to parse character index '${digits}': ${problem}`);
  }
  return Number(digits);
}

const OVERFLOW = "number too large to fit in target type";
const USIZE_MAX = 18446744073709551615n;

function usizeProblem(digits: string): string | null {
  if (digits === "") return "cannot parse integer from empty string";
  if (!/^\+?[0-9]+$/.test(digits) || digits === "+") return "invalid digit found in string";
  return BigInt(digits) > USIZE_MAX ? OVERFLOW : null;
}

function keyOptions(key: string, start: readonly string[], end: readonly string[]): KeyOptions {
  let modeLetter: string | null = null;
  let mode: SortMode = "text";
  let dictionary = false;
  let fold = false;
  let reverse = false;
  let blanksAtStart = false;
  let blanksAtEnd = false;
  const numericLike = (letter: string | null): boolean => letter === "n" || letter === "h";
  const letters = [
    ...start.map((letter) => ({ letter, atEnd: false })),
    ...end.map((letter) => ({ letter, atEnd: true })),
  ];
  for (const { letter, atEnd } of letters) {
    if (REFUSED_LETTERS.has(letter)) {
      throw new UsageError(`key '${key}': the '${letter}' ordering option is not supported`);
    }
    const selected = MODE_LETTERS.get(letter);
    if (selected !== undefined) {
      if (modeLetter !== null && modeLetter !== letter) {
        throw new KeyError(key, `options '-${modeLetter}${letter}' are incompatible`);
      }
      if (dictionary && numericLike(letter)) {
        throw new KeyError(key, `options '-d${letter}' are incompatible`);
      }
      modeLetter = letter;
      mode = selected;
    } else if (letter === "d") {
      if (numericLike(modeLetter)) {
        throw new KeyError(key, `options '-d${modeLetter ?? ""}' are incompatible`);
      }
      dictionary = true;
    } else if (letter === "f") {
      fold = true;
    } else if (letter === "r") {
      reverse = true;
    } else if (letter === "b") {
      if (atEnd) blanksAtEnd = true;
      else blanksAtStart = true;
    }
  }
  return { blanksAtStart, blanksAtEnd, dictionary, fold, mode, reverse };
}

/** Space, tab, and the other ASCII bytes Rust's `char::is_whitespace` accepts. */
export function isBlank(byte: number | undefined): boolean {
  return byte === 0x20 || (byte !== undefined && byte >= 0x09 && byte <= 0x0d);
}

/**
 * Where `key` starts in `line[start, end)`: the start field's first byte,
 * past its leading blanks under `b`, plus the character offset. An offset
 * is not held inside its field; only the line end bounds it.
 */
export function keyStart(
  line: Uint8Array,
  start: number,
  end: number,
  key: SortKey,
  separator: number | null,
): number {
  const field = fieldStart(line, start, end, key.startField, separator);
  const counted = key.options.blanksAtStart ? skipBlanks(line, field, end) : field;
  return Math.min(counted + key.startChar, end);
}

/**
 * Where `key` ends: the line end without an end field, the end of the end
 * field when its character is 0, and otherwise the field's first byte (past
 * blanks under `b`) plus the one-based character, bounded by the line end.
 */
export function keyEnd(
  line: Uint8Array,
  start: number,
  end: number,
  key: SortKey,
  separator: number | null,
): number {
  if (key.endField === null) return end;
  const field = fieldStart(line, start, end, key.endField, separator);
  if (key.endChar === 0) return fieldEnd(line, field, end, separator);
  const counted = key.options.blanksAtEnd ? skipBlanks(line, field, end) : field;
  return Math.min(counted + key.endChar, end);
}

/**
 * First byte of the zero-based `field`, or `end` when the line has fewer
 * fields. With a separator, a field begins after the previous separator.
 * Without one, a field begins at the blanks that precede its non-blanks.
 */
function fieldStart(
  line: Uint8Array,
  start: number,
  end: number,
  field: number,
  separator: number | null,
): number {
  let at = start;
  for (let skipped = 0; skipped < field && at < end; skipped++) {
    at = fieldEnd(line, at, end, separator);
    if (separator !== null && at < end) at++;
  }
  return at;
}

/** The byte after the field that begins at `at`. */
function fieldEnd(line: Uint8Array, at: number, end: number, separator: number | null): number {
  let cursor = at;
  if (separator !== null) {
    while (cursor < end && line[cursor] !== separator) cursor++;
    return cursor;
  }
  cursor = skipBlanks(line, cursor, end);
  while (cursor < end && !isBlank(line[cursor])) cursor++;
  return cursor;
}

function skipBlanks(line: Uint8Array, at: number, end: number): number {
  let cursor = at;
  while (cursor < end && isBlank(line[cursor])) cursor++;
  return cursor;
}
