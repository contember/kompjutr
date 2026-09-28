// jq values. Objects are Maps because jq keeps insertion order and a plain
// object would reorder integer-like keys. A number read from JSON or written
// in the program keeps its decimal literal, as jq 1.8 does: it prints the
// canonical literal until arithmetic turns it into a double.

export type JqValue = null | boolean | number | JqLiteral | string | JqArray | JqObject;
export type JqArray = readonly JqValue[];
export type JqObject = ReadonlyMap<string, JqValue>;
export type JqNumber = number | JqLiteral;

/** A decimal literal: `digits` without leading zeros, value = digits × 10^exponent. */
export class JqLiteral {
  #double: number | null = null;
  #text: string | null = null;

  constructor(
    readonly negative: boolean,
    readonly digits: string,
    readonly exponent: number,
    readonly infinite: boolean,
  ) {}

  /** The double jq computes: the literal rounded to 17 significant digits. */
  get value(): number {
    if (this.#double === null) this.#double = literalToDouble(this);
    return this.#double;
  }

  /** decNumber's to-scientific-string, or null for an infinity. */
  get text(): string | null {
    if (this.infinite) return null;
    if (this.#text === null) this.#text = sciString(this);
    return this.#text;
  }
}

export function isArray(value: JqValue): value is JqArray {
  return Array.isArray(value);
}

export function isObject(value: JqValue): value is JqObject {
  return value instanceof Map;
}

export function isNumber(value: JqValue): value is JqNumber {
  return typeof value === "number" || value instanceof JqLiteral;
}

export function numberValue(value: JqNumber): number {
  return typeof value === "number" ? value : value.value;
}

export function isNaNValue(value: JqNumber): boolean {
  return Number.isNaN(numberValue(value));
}

export function truthy(value: JqValue): boolean {
  return value !== null && value !== false;
}

export type Kind = "null" | "boolean" | "number" | "string" | "array" | "object";

export function kindOf(value: JqValue): Kind {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  if (isNumber(value)) return "number";
  if (isArray(value)) return "array";
  return "object";
}

/** jq's kind order: null < false < true < number < string < array < object. */
export function kindRank(value: JqValue): number {
  if (value === null) return 1;
  if (value === false) return 2;
  if (value === true) return 3;
  if (isNumber(value)) return 4;
  if (typeof value === "string") return 5;
  if (isArray(value)) return 6;
  return 7;
}

const DECIMAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const INFINITY = /^([+-]?)inf(?:inity)?$/i;
const NAN = /^[+-]?s?nan(\d*)$/i;
const EXPONENT_LIMIT = 999_999_999;

/**
 * decNumber's string syntax, as jq's JSON parser, lexer, and `tonumber` accept
 * it. Returns NaN for a NaN literal and null for invalid syntax.
 */
export function parseLiteral(text: string): JqLiteral | number | null {
  const decimal = DECIMAL.exec(text);
  if (decimal !== null) {
    const [, sign = "", whole, fraction, bare, exponentText] = decimal;
    const integer = whole ?? "";
    const fractional = fraction ?? bare ?? "";
    const exponent = Number(exponentText ?? "0") - fractional.length;
    const digits = `${integer}${fractional}`.replace(/^0+(?=.)/, "");
    if (exponent > EXPONENT_LIMIT) return new JqLiteral(sign === "-", "1", 0, true);
    return new JqLiteral(sign === "-", digits, Math.max(exponent, -EXPONENT_LIMIT), false);
  }
  const infinity = INFINITY.exec(text);
  if (infinity !== null) return new JqLiteral(infinity[1] === "-", "1", 0, true);
  const nan = NAN.exec(text);
  if (nan !== null) {
    const payload = nan[1] ?? "";
    return payload.length > 1 || (payload !== "" && payload !== "0") ? null : Number.NaN;
  }
  return null;
}

function sciString(literal: JqLiteral): string {
  const { digits, exponent } = literal;
  const sign = literal.negative ? "-" : "";
  const adjusted = exponent + digits.length - 1;
  if (exponent <= 0 && adjusted >= -6) {
    if (exponent === 0) return `${sign}${digits}`;
    const point = digits.length + exponent;
    if (point > 0) return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
    return `${sign}0.${"0".repeat(-point)}${digits}`;
  }
  const mantissa = digits.length > 1 ? `${digits.charAt(0)}.${digits.slice(1)}` : digits;
  return `${sign}${mantissa}E${adjusted >= 0 ? "+" : "-"}${Math.abs(adjusted)}`;
}

const DOUBLE_DIGITS = 17;

function literalToDouble(literal: JqLiteral): number {
  if (literal.infinite) return literal.negative ? -Infinity : Infinity;
  let digits = literal.digits;
  let exponent = literal.exponent;
  if (digits.length > DOUBLE_DIGITS) {
    const dropped = digits.length - DOUBLE_DIGITS;
    const kept = digits.slice(0, DOUBLE_DIGITS);
    const rest = digits.slice(DOUBLE_DIGITS);
    const half = rest.charAt(0);
    const beyond = /[1-9]/.test(rest.slice(1));
    const odd = Number(kept.charAt(kept.length - 1)) % 2 === 1;
    const up = half > "5" || (half === "5" && (beyond || odd));
    digits = up ? incrementDigits(kept) : kept;
    exponent += dropped;
  }
  const value = Number(`${digits}e${exponent}`);
  return literal.negative ? -value : value;
}

function incrementDigits(digits: string): string {
  const out = digits.split("");
  for (let index = out.length - 1; index >= 0; index--) {
    if (out[index] !== "9") {
      out[index] = String(Number(out[index]) + 1);
      return out.join("");
    }
    out[index] = "0";
  }
  return `1${out.join("")}`;
}

/** decNumberMinus: the sign flips, and a zero comes out positive. */
export function negateLiteral(literal: JqLiteral): JqLiteral {
  const zero = !literal.infinite && /^0+$/.test(literal.digits);
  return new JqLiteral(
    zero ? false : !literal.negative,
    literal.digits,
    literal.exponent,
    literal.infinite,
  );
}

export function absLiteral(literal: JqLiteral): JqLiteral {
  return new JqLiteral(false, literal.digits, literal.exponent, literal.infinite);
}

/** decNumberCompare over two literals: exact decimal order. */
export function compareLiterals(a: JqLiteral, b: JqLiteral): number {
  const signA = literalSign(a);
  const signB = literalSign(b);
  if (signA !== signB) return signA < signB ? -1 : 1;
  if (signA === 0) return 0;
  const magnitude = compareMagnitude(a, b);
  return signA < 0 ? -magnitude : magnitude;
}

function literalSign(literal: JqLiteral): number {
  if (!literal.infinite && /^0+$/.test(literal.digits)) return 0;
  return literal.negative ? -1 : 1;
}

function compareMagnitude(a: JqLiteral, b: JqLiteral): number {
  if (a.infinite || b.infinite) return a.infinite === b.infinite ? 0 : a.infinite ? 1 : -1;
  const adjustedA = a.exponent + a.digits.length;
  const adjustedB = b.exponent + b.digits.length;
  if (adjustedA !== adjustedB) return adjustedA < adjustedB ? -1 : 1;
  const width = Math.max(a.digits.length, b.digits.length);
  const left = a.digits.padEnd(width, "0");
  const right = b.digits.padEnd(width, "0");
  return left === right ? 0 : left < right ? -1 : 1;
}

/** jvp_dtoa_fmt: shortest round-trip digits in jq's %.17g-like layout. */
export function formatDouble(value: number): string {
  if (Number.isNaN(value)) return "null";
  const clamped =
    value > Number.MAX_VALUE
      ? Number.MAX_VALUE
      : value < -Number.MAX_VALUE
        ? -Number.MAX_VALUE
        : value;
  if (clamped === 0) return Object.is(clamped, -0) ? "-0" : "0";
  const sign = clamped < 0 ? "-" : "";
  const [mantissa = "", exponentText = "0"] = Math.abs(clamped).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  let decpt = Number(exponentText) + 1;
  if (decpt <= -4 || decpt > digits.length + 15) {
    const rest = digits.length > 1 ? `.${digits.slice(1)}` : "";
    decpt -= 1;
    const magnitude = String(Math.abs(decpt)).padStart(2, "0");
    return `${sign}${digits.charAt(0)}${rest}e${decpt < 0 ? "-" : "+"}${magnitude}`;
  }
  if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

export function formatNumber(value: JqNumber): string {
  if (typeof value === "number") return formatDouble(value);
  return value.text ?? formatDouble(value.value);
}

/** Code points of a string, as jq counts them. */
export function codePoints(text: string): number[] {
  const out: number[] = [];
  for (const char of text) out.push(char.codePointAt(0) ?? 0);
  return out;
}

export function codePointLength(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
}

const ENCODER = new TextEncoder();

export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

export function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

/** Slices by code point index, as jv_string_slice does. */
export function sliceCodePoints(text: string, start: number, end: number): string {
  let unitStart = -1;
  let unitEnd = text.length;
  let point = 0;
  for (let index = 0; index <= text.length; point++) {
    if (point === start) unitStart = index;
    if (point === end) {
      unitEnd = index;
      break;
    }
    if (index === text.length) break;
    const unit = text.charCodeAt(index);
    index += unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length ? 2 : 1;
  }
  return unitStart === -1 ? "" : text.slice(unitStart, unitEnd);
}
