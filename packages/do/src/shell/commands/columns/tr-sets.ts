// tr's SET grammar as uutils 0.2.2 parses it, byte-oriented: ranges, escapes,
// octal `\NNN`, `[:class:]`, `[=c=]`, `[c*]` and `[c*n]`, then the rules that
// align SET2 with SET1. At each position the alternatives are tried in the
// reference's order; a construct that does not parse falls back to its
// characters, which is how `[:foo:]` becomes seven literal bytes.

export class TrSetError extends Error {}

type Sequence =
  | { readonly kind: "char"; readonly byte: number }
  | { readonly kind: "range"; readonly low: number; readonly high: number }
  | { readonly kind: "star"; readonly byte: number }
  | { readonly kind: "repeat"; readonly byte: number; readonly count: number }
  | { readonly kind: "class"; readonly name: ClassName };

type ClassName =
  | "alnum"
  | "alpha"
  | "blank"
  | "cntrl"
  | "digit"
  | "graph"
  | "lower"
  | "print"
  | "punct"
  | "space"
  | "upper"
  | "xdigit";

const CLASS_NAMES: readonly ClassName[] = [
  "alnum",
  "alpha",
  "blank",
  "cntrl",
  "digit",
  "graph",
  "lower",
  "print",
  "punct",
  "space",
  "upper",
  "xdigit",
];

const ESCAPES = new Map<number, number>([
  [0x61, 0x07],
  [0x62, 0x08],
  [0x66, 0x0c],
  [0x6e, 0x0a],
  [0x72, 0x0d],
  [0x74, 0x09],
  [0x76, 0x0b],
]);

const BACKSLASH = 0x5c;
const LOSSY = new TextDecoder();

export interface SolvedSets {
  readonly set1: readonly number[];
  readonly set2: readonly number[];
}

/** `warn` receives the reference's warning text for an ambiguous octal escape. */
export function solveSets(
  set1Text: Uint8Array,
  set2Text: Uint8Array,
  options: { complement: boolean; truncate: boolean; translating: boolean },
  warn: (message: string) => void,
): SolvedSets {
  const set1 = parseSet(set1Text, warn);
  if (set1.some((item) => item.kind === "star")) {
    throw new TrSetError("the [c*] repeat construct may not appear in string1");
  }
  let set2 = parseSet(set2Text, warn);
  if (set2.filter((item) => item.kind === "star").length > 1) {
    throw new TrSetError("only one [c*] repeat construct may appear in string2");
  }
  if (
    options.translating &&
    set2.some((item) => item.kind === "class" && item.name !== "upper" && item.name !== "lower")
  ) {
    throw new TrSetError(
      "when translating, the only character classes that may appear in set2 are 'upper' and 'lower'",
    );
  }

  let set1Solved = set1.flatMap(expand);
  if (options.complement) {
    const members = new Set(set1Solved);
    set1Solved = [];
    for (let byte = 0; byte <= 0xff; byte++) if (!members.has(byte)) set1Solved.push(byte);
  }
  const set2Length = set2.filter((item) => item.kind !== "star").flatMap(expand).length;
  const compensate = Math.max(0, set1Solved.length - set2Length);
  set2 = set2.flatMap((item): Sequence[] => {
    if (item.kind !== "star") return [item];
    if (item.byte === 0) return [];
    return [{ kind: "repeat", byte: item.byte, count: compensate }];
  });

  for (let position = 0; position < set2.length; position++) {
    if (set2[position]?.kind !== "class") continue;
    const offset = set2.slice(0, position).flatMap(expand).length;
    const matched = set1.some(
      (item, index) =>
        item.kind === "class" && set1.slice(0, index).flatMap(expand).length === offset,
    );
    if (!matched) {
      throw new TrSetError(
        "when translating, every 'upper'/'lower' in set2 must be matched by a 'upper'/'lower' in the same position in set1",
      );
    }
  }

  const set2Solved = set2.flatMap(expand);
  if (
    set1.some((item) => item.kind === "class") &&
    options.translating &&
    options.complement &&
    (new Set(set2Solved).size > 1 || set2Solved.length > set1Solved.length)
  ) {
    throw new TrSetError(
      "when translating with complemented character classes,\nstring2 must map all characters in the domain to one",
    );
  }
  const lastItem = set2[set2.length - 1];
  if (
    set2Solved.length < set1Solved.length &&
    !options.truncate &&
    lastItem?.kind === "class" &&
    (lastItem.name === "upper" || lastItem.name === "lower")
  ) {
    throw new TrSetError(
      "when translating with string1 longer than string2,\nthe latter string must not end with a character class",
    );
  }
  if (options.truncate) set1Solved = set1Solved.slice(0, set2Solved.length);
  return { set1: set1Solved, set2: set2Solved };
}

function expand(item: Sequence): number[] {
  switch (item.kind) {
    case "char":
      return [item.byte];
    case "range":
      return span(item.low, item.high);
    case "star":
      throw new TrSetError("an unresolved [c*] construct cannot be expanded");
    case "repeat":
      return new Array<number>(item.count).fill(item.byte);
    case "class":
      return classBytes(item.name);
  }
}

function span(low: number, high: number): number[] {
  const bytes: number[] = [];
  for (let byte = low; byte <= high; byte++) bytes.push(byte);
  return bytes;
}

function classBytes(name: ClassName): number[] {
  const digits = span(0x30, 0x39);
  const upper = span(0x41, 0x5a);
  const lower = span(0x61, 0x7a);
  const punct = [...span(33, 47), ...span(58, 64), ...span(91, 96), ...span(123, 126)];
  switch (name) {
    case "alnum":
      return [...digits, ...upper, ...lower];
    case "alpha":
      return [...upper, ...lower];
    case "blank":
      return [0x09, 0x20];
    case "cntrl":
      return [...span(0, 31), 127];
    case "digit":
      return digits;
    // uutils lists space under graph and not under print; the order is its own.
    case "graph":
      return [...digits, ...upper, ...lower, ...punct, 32];
    case "print":
      return [...digits, ...upper, ...lower, ...punct];
    case "punct":
      return punct;
    case "space":
      return [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20];
    case "upper":
      return upper;
    case "lower":
      return lower;
    case "xdigit":
      return [...digits, ...span(0x41, 0x46), ...span(0x61, 0x66)];
  }
}

interface Parsed<T> {
  readonly value: T;
  readonly next: number;
}

function parseSet(input: Uint8Array, warn: (message: string) => void): Sequence[] {
  const items: Sequence[] = [];
  let firstError: TrSetError | null = null;
  let position = 0;
  while (position < input.length) {
    const parsed =
      parseRange(input, position) ??
      parseStar(input, position) ??
      parseRepeat(input, position) ??
      parseClass(input, position) ??
      parseEqual(input, position) ??
      charWithWarning(input, position, warn);
    if (parsed.value instanceof TrSetError) firstError ??= parsed.value;
    else items.push(parsed.value);
    position = parsed.next;
  }
  if (firstError !== null) throw firstError;
  return items;
}

type Attempt = Parsed<Sequence | TrSetError> | null;

function parseRange(input: Uint8Array, at: number): Attempt {
  const low = plainChar(input, at);
  if (low === null || input[low.next] !== 0x2d) return null;
  const high = plainChar(input, low.next + 1);
  if (high === null) return null;
  if (high.value < low.value) {
    return {
      value: new TrSetError(
        `range-endpoints of '${endpoint(low.value)}-${endpoint(high.value)}' are in reverse collating sequence order`,
      ),
      next: high.next,
    };
  }
  return { value: { kind: "range", low: low.value, high: high.value }, next: high.next };
}

function endpoint(byte: number): string {
  if (byte >= 0x20 && byte <= 0x7e) {
    const char = String.fromCharCode(byte);
    return char === "\\" || char === "'" || char === '"' ? `\\${char}` : char;
  }
  return `\\${byte.toString(8).padStart(3, "0")}`;
}

function parseStar(input: Uint8Array, at: number): Attempt {
  if (input[at] !== 0x5b) return null;
  const char = plainChar(input, at + 1);
  if (char === null || input[char.next] !== 0x2a || input[char.next + 1] !== 0x5d) return null;
  return { value: { kind: "star", byte: char.value }, next: char.next + 2 };
}

function parseRepeat(input: Uint8Array, at: number): Attempt {
  if (input[at] !== 0x5b) return null;
  const char = plainChar(input, at + 1);
  if (char === null || input[char.next] !== 0x2a) return null;
  let end = char.next + 1;
  while (end < input.length && input[end] !== 0x5d && input[end] !== BACKSLASH) end++;
  if (input[end] !== 0x5d) return null;
  const count = LOSSY.decode(input.subarray(char.next + 1, end));
  const parsed = count.startsWith("0") ? parseUnsigned(count, 8) : parseUnsigned(count, 10);
  const next = end + 1;
  if (parsed === null) {
    return { value: new TrSetError(`invalid repeat count '${count}' in [c*n] construct`), next };
  }
  if (parsed === 0) return { value: { kind: "star", byte: char.value }, next };
  return { value: { kind: "repeat", byte: char.value, count: parsed }, next };
}

/** Rust's `usize` parse in a radix: an optional `+`, then digits. */
function parseUnsigned(text: string, radix: 8 | 10): number | null {
  const digits = radix === 10 && text.startsWith("+") ? text.slice(1) : text;
  const pattern = radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!pattern.test(digits)) return null;
  const value = Number.parseInt(digits, radix);
  return Number.isSafeInteger(value) ? value : null;
}

function parseClass(input: Uint8Array, at: number): Attempt {
  if (input[at] !== 0x5b || input[at + 1] !== 0x3a) return null;
  const body = at + 2;
  for (const name of CLASS_NAMES) {
    const end = body + name.length;
    if (asciiAt(input, body, name) && input[end] === 0x3a && input[end + 1] === 0x5d) {
      return { value: { kind: "class", name }, next: end + 2 };
    }
  }
  if (input[body] === 0x3a && input[body + 1] === 0x5d) {
    return { value: new TrSetError("missing character class name '[::]'"), next: body + 2 };
  }
  return null;
}

function parseEqual(input: Uint8Array, at: number): Attempt {
  if (input[at] !== 0x5b || input[at + 1] !== 0x3d) return null;
  const body = at + 2;
  const missing = input[body] === 0x3d && input[body + 1] === 0x5d;
  const char = missing ? { value: 0, next: body } : plainChar(input, body);
  if (char === null) return null;
  const close = findClose(input, char.next);
  if (close === -1) return null;
  const next = close + 2;
  if (missing) return { value: new TrSetError("missing equivalence class character '[==]'"), next };
  if (close > char.next) {
    const text =
      LOSSY.decode(Uint8Array.of(char.value)) + LOSSY.decode(input.subarray(char.next, close));
    return {
      value: new TrSetError(`${text}: equivalence class operand must be a single character`),
      next,
    };
  }
  return { value: { kind: "char", byte: char.value }, next };
}

function findClose(input: Uint8Array, from: number): number {
  for (let index = from; index + 1 < input.length; index++) {
    if (input[index] === 0x3d && input[index + 1] === 0x5d) return index;
  }
  return -1;
}

function asciiAt(input: Uint8Array, at: number, text: string): boolean {
  for (let offset = 0; offset < text.length; offset++) {
    if (input[at + offset] !== text.charCodeAt(offset)) return false;
  }
  return true;
}

/** An octal escape, a backslash escape, or one byte — never warning. */
function plainChar(input: Uint8Array, at: number): Parsed<number> | null {
  const first = input[at];
  if (first === undefined) return null;
  if (first === BACKSLASH) {
    const octal = octalDigits(input, at + 1, 3);
    if (octal !== null) {
      const value = Number.parseInt(octal, 8);
      if (value <= 0xff) return { value, next: at + 1 + octal.length };
    }
    const escaped = input[at + 1];
    if (escaped !== undefined) return { value: ESCAPES.get(escaped) ?? escaped, next: at + 2 };
  }
  return { value: first, next: at + 1 };
}

/** The last alternative: as `plainChar`, but `\400` warns and reads as `\40` then `0`. */
function charWithWarning(
  input: Uint8Array,
  at: number,
  warn: (message: string) => void,
): Parsed<Sequence> {
  if (input[at] === BACKSLASH) {
    const octal = octalDigits(input, at + 1, 3);
    if (octal !== null) {
      const value = Number.parseInt(octal, 8);
      if (value <= 0xff)
        return { value: { kind: "char", byte: value }, next: at + 1 + octal.length };
      const rest = LOSSY.decode(input.subarray(at + 1));
      warn(
        `the ambiguous octal escape \\${rest} is being interpreted as the 2-byte sequence \\0${octal.slice(0, 2)}, ${octal.charAt(2)}`,
      );
      return { value: { kind: "char", byte: Number.parseInt(octal.slice(0, 2), 8) }, next: at + 3 };
    }
  }
  const char = plainChar(input, at);
  if (char === null) throw new TrSetError("empty set position");
  return { value: { kind: "char", byte: char.value }, next: char.next };
}

function octalDigits(input: Uint8Array, at: number, most: number): string | null {
  let digits = "";
  while (digits.length < most) {
    const byte = input[at + digits.length];
    if (byte === undefined || byte < 0x30 || byte > 0x37) break;
    digits += String.fromCharCode(byte);
  }
  return digits === "" ? null : digits;
}
