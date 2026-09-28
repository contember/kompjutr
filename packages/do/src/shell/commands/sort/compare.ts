// The orderings `sort` keys use, over byte ranges in the C locale.
//
// Numbers compare as exact decimals, never through floating point, so
// `sort -n` agrees with the reference on values past 2^53. Version order is
// gnulib's `filevercmp`, which uutils `-V` matches.

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

export function compareVersions(left: Span, right: Span): number {
  const a = left.bytes.subarray(left.start, left.end);
  const b = right.bytes.subarray(right.start, right.end);
  if (a.length === 0) return b.length === 0 ? 0 : -1;
  if (b.length === 0) return 1;
  if (a[0] === 0x2e) {
    if (b[0] !== 0x2e) return -1;
    const aDot = a.length === 1;
    const bDot = b.length === 1;
    if (aDot) return bDot ? 0 : -1;
    if (bDot) return 1;
    const aDotDot = a[1] === 0x2e && a.length === 2;
    const bDotDot = b[1] === 0x2e && b.length === 2;
    if (aDotDot) return bDotDot ? 0 : -1;
    if (bDotDot) return 1;
  } else if (b[0] === 0x2e) {
    return 1;
  }
  const aPrefix = suffixStart(a);
  const bPrefix = suffixStart(b);
  const result = versionOrder(a, aPrefix, b, bPrefix);
  if (result !== 0 || (aPrefix === a.length && bPrefix === b.length)) return result;
  return versionOrder(a, a.length, b, b.length);
}

/** Length of the name before a suffix like `.tar.gz`: `(\.[A-Za-z~][A-Za-z0-9~]*)*$`. */
function suffixStart(bytes: Uint8Array): number {
  let prefix = 0;
  let index = 0;
  while (index < bytes.length) {
    index++;
    prefix = index;
    while (
      index + 1 < bytes.length &&
      bytes[index] === 0x2e &&
      (isAlpha(bytes[index + 1]) || bytes[index + 1] === 0x7e)
    ) {
      for (
        index += 2;
        index < bytes.length && (isAlphanumeric(bytes[index] ?? 0) || bytes[index] === 0x7e);
        index++
      ) {
        // Skip the suffix word.
      }
    }
  }
  return prefix;
}

function characterOrder(bytes: Uint8Array, at: number, length: number): number {
  if (at === length) return -1;
  const byte = bytes[at] ?? 0;
  if (isDigit(byte)) return 0;
  if (isAlpha(byte)) return byte;
  if (byte === 0x7e) return -2;
  return byte + 256;
}

function versionOrder(a: Uint8Array, aLength: number, b: Uint8Array, bLength: number): number {
  let ai = 0;
  let bi = 0;
  while (ai < aLength || bi < bLength) {
    let firstDifference = 0;
    while ((ai < aLength && !isDigit(a[ai])) || (bi < bLength && !isDigit(b[bi]))) {
      const ac = characterOrder(a, ai, aLength);
      const bc = characterOrder(b, bi, bLength);
      if (ac !== bc) return ac - bc;
      ai++;
      bi++;
    }
    while (ai < aLength && a[ai] === 0x30) ai++;
    while (bi < bLength && b[bi] === 0x30) bi++;
    while (ai < aLength && bi < bLength && isDigit(a[ai]) && isDigit(b[bi])) {
      if (firstDifference === 0) firstDifference = (a[ai] ?? 0) - (b[bi] ?? 0);
      ai++;
      bi++;
    }
    if (ai < aLength && isDigit(a[ai])) return 1;
    if (bi < bLength && isDigit(b[bi])) return -1;
    if (firstDifference !== 0) return firstDifference;
  }
  return 0;
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
