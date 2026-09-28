// `sort -k KEYDEF` parsing and field extraction.
//
// Parsing follows uutils sort 0.2.2, whose diagnostics the parity suite pins.
// Extraction follows POSIX as GNU implements it (`begfield`/`limfield`):
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

/** Where `key` starts in `line[start, end)`. */
export function keyStart(
  line: Uint8Array,
  start: number,
  end: number,
  key: SortKey,
  separator: number | null,
): number {
  let at = start;
  for (let field = key.startField; at < end && field > 0; field--) {
    if (separator !== null) {
      while (at < end && line[at] !== separator) at++;
      if (at < end) at++;
    } else {
      while (at < end && isBlank(line[at])) at++;
      while (at < end && !isBlank(line[at])) at++;
    }
  }
  if (key.options.blanksAtStart) while (at < end && isBlank(line[at])) at++;
  return Math.min(end, at + key.startChar);
}

/** Where `key` ends in `line[start, end)`. */
export function keyEnd(
  line: Uint8Array,
  start: number,
  end: number,
  key: SortKey,
  separator: number | null,
): number {
  if (key.endField === null) return end;
  let at = start;
  let fields = key.endChar === 0 ? key.endField + 1 : key.endField;
  while (at < end && fields > 0) {
    fields--;
    if (separator !== null) {
      while (at < end && line[at] !== separator) at++;
      if (at < end && (fields > 0 || key.endChar !== 0)) at++;
    } else {
      while (at < end && isBlank(line[at])) at++;
      while (at < end && !isBlank(line[at])) at++;
    }
  }
  if (key.endChar !== 0) {
    if (key.options.blanksAtEnd) while (at < end && isBlank(line[at])) at++;
    at = Math.min(end, at + key.endChar);
  }
  return at;
}
