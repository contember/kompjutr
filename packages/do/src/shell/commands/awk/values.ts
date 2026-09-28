// awk values and the conversions between them, as mawk shows them.
//
// A value is a number, a string, a "strnum" (input text that looks numeric,
// which compares as a number but prints as its text), or uninitialized
// (`null`). Strings hold one character per byte (latin1), so `length`,
// `substr`, and comparisons count and order bytes as mawk does in the C locale.

import { formatSingleNumber } from "./format/format.js";

export class StrNum {
  constructor(
    readonly text: string,
    readonly number: number,
  ) {}
}

export type Value = number | string | StrNum | null;

/** The blanks that separate default fields and surround numbers: blank, tab, and newline. */
export function isAwkSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a;
}

const NUMBER_PREFIX = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;
const WHOLE_NUMBER = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const SMALLEST_NORMAL = 2.2250738585072014e-308;

/** `strtod` on the leading number, without hexadecimal, `inf`, or `nan`. */
export function parseNumberPrefix(text: string): number {
  let start = 0;
  while (start < text.length && isAwkSpace(text.charCodeAt(start))) start++;
  const match = NUMBER_PREFIX.exec(start === 0 ? text : text.slice(start));
  return match === null ? 0 : Number(match[0]);
}

/** Input text becomes a strnum when all of it, blanks aside, is one decimal number. */
export function maybeNumber(text: string): Value {
  let start = 0;
  let end = text.length;
  while (start < end && isAwkSpace(text.charCodeAt(start))) start++;
  while (end > start && isAwkSpace(text.charCodeAt(end - 1))) end--;
  if (start === end) return text;
  const body = start === 0 && end === text.length ? text : text.slice(start, end);
  if (!WHOLE_NUMBER.test(body)) return text;
  const number = Number(body);
  if (!Number.isFinite(number)) return text;
  // Text that underflows a double stays text, as mawk shows.
  if (
    number === 0 ? /[1-9]/.test(body.replace(/[eE].*$/, "")) : Math.abs(number) < SMALLEST_NORMAL
  ) {
    return text;
  }
  return new StrNum(text, number);
}

export function toNumber(value: Value): number {
  if (typeof value === "number") return value;
  if (value === null) return 0;
  if (typeof value === "string") return parseNumberPrefix(value);
  return value.number;
}

const TWO_63 = 2 ** 63;
const TWO_64 = 2 ** 64;

/**
 * mawk prints an integral double as an integer when it fits a C integer and
 * otherwise through CONVFMT or OFMT. Output (print) admits unsigned 64-bit
 * values; conversion (concatenation, subscripts) admits signed ones.
 */
export function numberText(value: number, format: string, output: boolean): string {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return "-nan";
    if (output) return value > 0 ? "+inf" : "-inf";
    return value > 0 ? "inf" : "-inf";
  }
  const magnitude = Math.abs(value);
  if (magnitude === TWO_63 || magnitude === TWO_64) return BigInt(value).toString();
  if (Number.isInteger(value) && value > -TWO_63 && value < (output ? TWO_64 : TWO_63)) {
    return magnitude < 2 ** 53 ? String(value === 0 ? 0 : value) : BigInt(value).toString();
  }
  return formatSingleNumber(format, value);
}

export interface Formats {
  readonly convfmt: string;
  readonly ofmt: string;
}

export function toText(value: Value, formats: Formats): string {
  if (typeof value === "string") return value;
  if (value === null) return "";
  if (typeof value === "number") return numberText(value, formats.convfmt, false);
  return value.text;
}

export function toOutputText(value: Value, formats: Formats): string {
  if (typeof value === "number") return numberText(value, formats.ofmt, true);
  return toText(value, formats);
}

export function truthy(value: Value): boolean {
  if (typeof value === "number") return value !== 0;
  if (value === null) return false;
  if (typeof value === "string") return value.length > 0;
  return value.number !== 0;
}

/** Compare as text when either side is a plain string, numerically otherwise. */
export function compare(left: Value, right: Value, formats: Formats): number {
  if (typeof left === "string" || typeof right === "string") {
    const a = toText(left, formats);
    const b = toText(right, formats);
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (left === null && right === null) return 0;
  const a = toNumber(left);
  const b = toNumber(right);
  return a > b ? 1 : a < b ? -1 : 0;
}

export function byteLength(value: Value): number {
  if (typeof value === "string") return value.length;
  if (value !== null && typeof value === "object") return value.text.length;
  return 8;
}
