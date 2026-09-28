// The orderings `sort` keys use, over byte ranges in the C locale.
//
// Numbers compare as exact decimals, never through floating point, so
// `sort -n` agrees with the reference on values past 2^53. Version order is
// the coreutils manual's version sort, which uutils `-V` matches.

import { isBlank, type KeyOptions } from "./keys.js";

/** A line, or one key of it: `bytes[start, end)`. */
export interface Span {
  readonly bytes: Uint8Array;
  readonly start: number;
  readonly end: number;
}

export function compareSpans(left: Span, right: Span, options: KeyOptions): number {
  if (options.mode === "text") {
    return options.dictionary || options.fold
      ? compareFiltered(left, right, options)
      : compareBytes(left, right);
  }
  // uutils applies -d and -f before a number is read, but not to a version.
  if (options.mode === "version") return compareVersions(left, right);
  const a = options.dictionary || options.fold ? filtered(left, options) : left;
  const b = options.dictionary || options.fold ? filtered(right, options) : right;
  if (options.mode === "numeric") return compareDecimals(decimal(a, false), decimal(b, false));
  return compareHuman(a, b);
}

export function compareBytes(left: Span, right: Span): number {
  const length = Math.min(left.end - left.start, right.end - right.start);
  for (let index = 0; index < length; index++) {
    const difference =
      (left.bytes[left.start + index] ?? 0) - (right.bytes[right.start + index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.end - left.start - (right.end - right.start);
}

function ignored(byte: number, options: KeyOptions): boolean {
  return options.dictionary && !(isAlphanumeric(byte) || byte === 0x20 || byte === 0x09);
}

function translated(byte: number, options: KeyOptions): number {
  return options.fold && byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte;
}

function compareFiltered(left: Span, right: Span, options: KeyOptions): number {
  let a = left.start;
  let b = right.start;
  for (;;) {
    while (a < left.end && ignored(left.bytes[a] ?? 0, options)) a++;
    while (b < right.end && ignored(right.bytes[b] ?? 0, options)) b++;
    if (a >= left.end || b >= right.end) break;
    const difference =
      translated(left.bytes[a] ?? 0, options) - translated(right.bytes[b] ?? 0, options);
    if (difference !== 0) return difference;
    a++;
    b++;
  }
  return Number(a < left.end) - Number(b < right.end);
}

function filtered(span: Span, options: KeyOptions): Span {
  const out: number[] = [];
  for (let index = span.start; index < span.end; index++) {
    const byte = span.bytes[index] ?? 0;
    if (!ignored(byte, options)) out.push(translated(byte, options));
  }
  return { bytes: Uint8Array.from(out), start: 0, end: out.length };
}

interface Decimal {
  readonly negative: boolean;
  readonly bytes: Uint8Array;
  /** Integer digits without leading zeros. */
  readonly integer: readonly [number, number];
  /** Fraction digits without trailing zeros. */
  readonly fraction: readonly [number, number];
  /** Where parsing stopped. */
  readonly end: number;
}

/**
 * Leading blanks, an optional `-`, digits, and one optional `.` with more
 * digits. Anything else ends the number; no digits at all is zero. `plus`
 * admits a leading `+`, which only whole-line `-n` accepts.
 */
function decimal(span: Span, plus: boolean): Decimal {
  const bytes = span.bytes;
  let at = span.start;
  while (at < span.end && isBlank(bytes[at])) at++;
  let negative = false;
  if (at < span.end && bytes[at] === 0x2d) {
    negative = true;
    at++;
  } else if (plus && at < span.end && bytes[at] === 0x2b) {
    at++;
  }
  let integerStart = at;
  while (at < span.end && isDigit(bytes[at])) at++;
  const integerEnd = at;
  while (integerStart < integerEnd && bytes[integerStart] === 0x30) integerStart++;
  let fractionStart = at;
  let fractionEnd = at;
  if (at < span.end && bytes[at] === 0x2e) {
    at++;
    fractionStart = at;
    while (at < span.end && isDigit(bytes[at])) at++;
    fractionEnd = at;
    while (fractionEnd > fractionStart && bytes[fractionEnd - 1] === 0x30) fractionEnd--;
  }
  const zero = integerStart === integerEnd && fractionStart === fractionEnd;
  return {
    negative: negative && !zero,
    bytes,
    integer: [integerStart, integerEnd],
    fraction: [fractionStart, fractionEnd],
    end: at,
  };
}

function compareDecimals(left: Decimal, right: Decimal): number {
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const magnitude = compareMagnitudes(left, right);
  return left.negative ? -magnitude : magnitude;
}

function compareMagnitudes(left: Decimal, right: Decimal): number {
  const leftDigits = left.integer[1] - left.integer[0];
  const rightDigits = right.integer[1] - right.integer[0];
  if (leftDigits !== rightDigits) return leftDigits - rightDigits;
  for (let index = 0; index < leftDigits; index++) {
    const difference =
      (left.bytes[left.integer[0] + index] ?? 0) - (right.bytes[right.integer[0] + index] ?? 0);
    if (difference !== 0) return difference;
  }
  const leftFraction = left.fraction[1] - left.fraction[0];
  const rightFraction = right.fraction[1] - right.fraction[0];
  const shared = Math.min(leftFraction, rightFraction);
  for (let index = 0; index < shared; index++) {
    const difference =
      (left.bytes[left.fraction[0] + index] ?? 0) - (right.bytes[right.fraction[0] + index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftFraction - rightFraction;
}

/**
 * uutils compares two whole lines that are both plain numbers directly, and
 * that path admits a leading `+`. Only whole-line `sort -n` takes it.
 */
export function comparePlainNumbers(left: Span, right: Span): number | null {
  if (!isPlainNumber(left) || !isPlainNumber(right)) return null;
  return compareDecimals(decimal(left, true), decimal(right, true));
}

/** `[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)` and nothing else. */
function isPlainNumber(span: Span): boolean {
  let at = span.start;
  const sign = span.bytes[at];
  if (at < span.end && (sign === 0x2b || sign === 0x2d)) at++;
  let digits = 0;
  for (; at < span.end && isDigit(span.bytes[at]); at++) digits++;
  if (at < span.end && span.bytes[at] === 0x2e) {
    for (at++; at < span.end && isDigit(span.bytes[at]); at++) digits++;
  }
  return digits > 0 && at === span.end;
}

const UNIT_ORDER: ReadonlyMap<number, number> = new Map(
  Array.from("KMGTPEZYRQ", (unit, index) => [unit.charCodeAt(0), index + 1] as const).concat([
    [0x6b, 1],
  ]),
);

function compareHuman(left: Span, right: Span): number {
  const a = decimal(left, false);
  const b = decimal(right, false);
  const difference = unitOrder(a) - unitOrder(b);
  return difference !== 0 ? difference : compareDecimals(a, b);
}

function unitOrder(number: Decimal): number {
  const nonzero = number.integer[0] < number.integer[1] || number.fraction[0] < number.fraction[1];
  if (!nonzero) return 0;
  const order = UNIT_ORDER.get(number.bytes[number.end] ?? 0) ?? 0;
  return number.negative ? -order : order;
}

/**
 * Follows uutils coreutils (MIT) `uucore::version_cmp`, the host `sort -V`.
 * Equal bytes are equal. Otherwise the empty string, `.`, `..`, and then
 * any other dot-name sort first, in that order; two dot-names drop their dot.
 * A file suffix is ignored unless the two names differ only there. The rest
 * alternates a non-digit run, compared by `compareVersionText`, with a digit
 * run, compared by value.
 */
export function compareVersions(left: Span, right: Span): number {
  if (compareBytes(left, right) === 0) return 0;
  for (const special of SPECIAL_NAMES) {
    const difference = Number(!equalsText(left, special)) - Number(!equalsText(right, special));
    if (difference !== 0) return difference;
  }
  let a = left;
  let b = right;
  const leftDot = startsWithDot(left);
  const rightDot = startsWithDot(right);
  if (leftDot !== rightDot) return leftDot ? -1 : 1;
  if (leftDot) {
    a = { bytes: a.bytes, start: a.start + 1, end: a.end };
    b = { bytes: b.bytes, start: b.start + 1, end: b.end };
  }
  const aStem = withoutSuffix(a);
  const bStem = withoutSuffix(b);
  if (compareBytes(aStem, bStem) !== 0) {
    a = aStem;
    b = bStem;
  }

  let x = a.start;
  let y = b.start;
  while (x < a.end || y < b.end) {
    const xDigits = findByte(a.bytes, x, a.end, isDigit);
    const yDigits = findByte(b.bytes, y, b.end, isDigit);
    const text = compareVersionText(a.bytes, x, xDigits, b.bytes, y, yDigits);
    if (text !== 0) return text;
    x = xDigits;
    y = yDigits;
    const xEnd = findByte(a.bytes, x, a.end, (byte) => !isDigit(byte));
    const yEnd = findByte(b.bytes, y, b.end, (byte) => !isDigit(byte));
    const xSignificant = findByte(a.bytes, x, xEnd, (byte) => byte !== 0x30);
    const ySignificant = findByte(b.bytes, y, yEnd, (byte) => byte !== 0x30);
    const digits = xEnd - xSignificant - (yEnd - ySignificant);
    if (digits !== 0) return digits;
    const number = compareBytes(
      { bytes: a.bytes, start: xSignificant, end: xEnd },
      { bytes: b.bytes, start: ySignificant, end: yEnd },
    );
    if (number !== 0) return number;
    x = xEnd;
    y = yEnd;
  }
  return 0;
}

const SPECIAL_NAMES: readonly string[] = ["", ".", ".."];

function equalsText(span: Span, text: string): boolean {
  if (span.end - span.start !== text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (span.bytes[span.start + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function startsWithDot(span: Span): boolean {
  return span.start < span.end && span.bytes[span.start] === 0x2e;
}

function findByte(
  bytes: Uint8Array,
  from: number,
  end: number,
  found: (byte: number) => boolean,
): number {
  let at = from;
  while (at < end && !found(bytes[at] ?? 0)) at++;
  return at;
}

/**
 * Two non-digit runs: `~` sorts before everything, the end of a run
 * included; then letters sort before other bytes; then plain byte order.
 */
function compareVersionText(
  left: Uint8Array,
  leftStart: number,
  leftEnd: number,
  right: Uint8Array,
  rightStart: number,
  rightEnd: number,
): number {
  let x = leftStart;
  let y = rightStart;
  for (; x < leftEnd || y < rightEnd; x++, y++) {
    const a = x < leftEnd ? left[x] : undefined;
    const b = y < rightEnd ? right[y] : undefined;
    if (a === b) continue;
    if (b === TILDE) return 1;
    if (a === TILDE) return -1;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (isAlpha(a) !== isAlpha(b)) return isAlpha(a) ? -1 : 1;
    return a - b;
  }
  return 0;
}

const TILDE = 0x7e;

/** The span without the file suffix uutils matches as `(\.[A-Za-z~][A-Za-z0-9~]*)*$`. */
function withoutSuffix(span: Span): Span {
  let suffixStart: number | null = null;
  let afterDot = false;
  for (let at = span.start; at < span.end; at++) {
    const byte = span.bytes[at] ?? 0;
    if (byte === 0x2e) {
      if (suffixStart === null || afterDot) suffixStart = at;
      afterDot = true;
    } else if (afterDot) {
      afterDot = false;
      if (!isAlpha(byte) && byte !== TILDE) suffixStart = null;
    } else if (!isAlphanumeric(byte) && byte !== TILDE) {
      suffixStart = null;
    }
  }
  if (afterDot || suffixStart === null) return span;
  return { bytes: span.bytes, start: span.start, end: suffixStart };
}

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

function isAlpha(byte: number | undefined): boolean {
  return byte !== undefined && ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a));
}

function isAlphanumeric(byte: number): boolean {
  return isDigit(byte) || isAlpha(byte);
}
