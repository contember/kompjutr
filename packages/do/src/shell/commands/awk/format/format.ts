// `printf` and `sprintf`: arguments are consumed as the format is scanned,
// `%c` and `%s` pad themselves, and the numeric conversions follow C, with the
// outputs mawk shows for values at or past the 64-bit integer bounds and for
// infinities and NaN (printed as `+inf`, `-inf`, `-nan`, ignoring the spec).

import type { Value } from "../values.js";
import {
  type ConversionFlags,
  type FloatConversion,
  formatFloat,
  formatInteger,
  NO_FLAGS,
} from "./cformat.js";

export interface Converter {
  number(value: Value): number;
  text(value: Value): string;
  /** Called before building a padded field of `bytes` characters. */
  guard(bytes: number): void;
}

/** A printf failure; the caller reports it as an awk run time error. */
export class FormatError extends Error {
  /** What `printf` had already written: output before a failing conversion is kept. */
  partial = "";
}

const TWO_63 = 2 ** 63;
const TWO_64 = 2 ** 64;
const MAX_INT = 2 ** 31 - 1;

function toCInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value >= MAX_INT) return MAX_INT;
  if (value <= -MAX_INT) return -MAX_INT;
  return Math.trunc(value);
}

function toLong(value: number): bigint {
  if (value >= TWO_63) return 2n ** 63n - 1n;
  if (value < -TWO_63) return -(2n ** 63n - 1n);
  return BigInt(Math.trunc(value));
}

function toUnsignedLong(value: number): bigint {
  if (value >= TWO_64) return 2n ** 64n - 1n;
  if (value <= -TWO_64) return 1n;
  return BigInt.asUintN(64, BigInt(Math.trunc(value)));
}

function signedSpecial(value: number): string {
  const text = Number.isNaN(value) ? "-nan" : value < 0 ? "-inf" : "inf";
  return text.startsWith("-") ? text : `+${text}`;
}

/** Exactly 2^63 and 2^64 print as their integer digits. */
function boundText(value: number): string {
  return BigInt(value).toString();
}

interface Cursor {
  readonly args: readonly Value[];
  next: number;
}

function take(cursor: Cursor): Value {
  const value = cursor.args[cursor.next];
  cursor.next++;
  return value === undefined ? null : value;
}

/** Pad `%s` and `%c` text: the `0` flag is ignored, and a blank flag on empty text prints a blank. */
function padText(
  text: string,
  flags: ConversionFlags,
  width: number | null,
  precision: number | null,
): string {
  let body = text;
  let lead = "";
  if (flags.space && body.length === 0) lead = " ";
  if (precision !== null && precision >= 0 && body.length > precision) {
    body = body.slice(0, precision);
  }
  if (width === null || body.length >= width) return `${lead}${body}`;
  const fill = " ".repeat(width - body.length);
  return flags.minus ? `${lead}${body}${fill}` : `${lead}${fill}${body}`;
}

export function sprintf(
  who: "printf" | "sprintf",
  format: string,
  args: readonly Value[],
  convert: Converter,
): string {
  const state = { out: "" };
  try {
    scan(state, who, format, args, convert);
    return state.out;
  } catch (error) {
    if (error instanceof FormatError) error.partial = state.out;
    throw error;
  }
}

function scan(
  state: { out: string },
  who: "printf" | "sprintf",
  format: string,
  args: readonly Value[],
  convert: Converter,
): void {
  const cursor: Cursor = { args, next: 0 };
  let index = 0;
  let conversions = 0;
  const bad = (): FormatError =>
    new FormatError(`improper conversion(number ${conversions}) in ${who}("${format}")`);

  for (;;) {
    const percent = format.indexOf("%", index);
    const end = format.indexOf("\0", index);
    if (percent === -1 || (end !== -1 && end < percent)) {
      state.out += format.slice(index, end === -1 ? format.length : end);
      return;
    }
    state.out += format.slice(index, percent);
    conversions++;
    index = percent + 1;
    if (format.charAt(index) === "%") {
      state.out += "%";
      index++;
      continue;
    }

    const flags = {
      minus: false,
      plus: false,
      space: false,
      alternate: false,
      zero: false,
    };
    for (;;) {
      const char = format.charAt(index);
      if (char === "-") flags.minus = true;
      else if (char === "+") flags.plus = true;
      else if (char === " ") flags.space = true;
      else if (char === "#") flags.alternate = true;
      else if (char === "0") flags.zero = true;
      else if (char !== "'") break;
      index++;
    }

    let width: number | null = null;
    if (format.charAt(index) === "*") {
      width = toCInt(convert.number(take(cursor)));
      index++;
    } else {
      const digits = /^[0-9]*/.exec(format.slice(index))?.[0] ?? "";
      if (digits !== "") width = Number(digits);
      index += digits.length;
    }
    if (width !== null && width < 0) {
      flags.minus = true;
      width = -width;
    }

    let precision: number | null = null;
    let textPrecision: number | null = null;
    if (format.charAt(index) === ".") {
      index++;
      if (format.charAt(index) === "*") {
        precision = toCInt(convert.number(take(cursor)));
        textPrecision = precision;
        index++;
      } else {
        const digits = /^[0-9]*/.exec(format.slice(index))?.[0] ?? "";
        precision = digits === "" ? 0 : Number(digits);
        textPrecision = digits === "" ? null : precision;
        index += digits.length;
      }
      if (precision < 0) {
        precision = null;
        textPrecision = null;
      }
    }

    if (cursor.next >= args.length) {
      throw new FormatError(`not enough arguments passed to ${who}("${format}")`);
    }

    let longs = 0;
    while (format.charAt(index) === "l" || format.charAt(index) === "h") {
      if (format.charAt(index) === "h") {
        throw new FormatError(`the h length modifier is not supported in ${who}("${format}")`);
      }
      longs++;
      index++;
    }
    const conversion = format.charAt(index);
    index++;
    convert.guard(Math.max(width ?? 0, precision ?? 0));
    const value = take(cursor);
    const special = typeof value === "number" && !Number.isFinite(value);
    if (special && "scdiouxXefgEG".includes(conversion) && conversion !== "") {
      state.out += signedSpecial(value);
      continue;
    }
    const numeric = { ...flags };

    switch (conversion) {
      case "s":
        if (longs > 0) throw bad();
        state.out += padText(convert.text(value), flags, width, textPrecision);
        break;
      case "c": {
        if (longs > 0) throw bad();
        let code = 0;
        if (typeof value === "string") code = value.length > 0 ? value.charCodeAt(0) : 0;
        else if (value !== null) code = Number(BigInt.asUintN(8, toLong(convert.number(value))));
        state.out += padText(String.fromCharCode(code), flags, width, null);
        break;
      }
      case "d":
      case "i": {
        const number = convert.number(value);
        const magnitude = Math.abs(number);
        if (magnitude === TWO_63 || magnitude === TWO_64) state.out += boundText(number);
        else if (magnitude > TWO_64) state.out += formatFloat(number, "g", NO_FLAGS, 0, 6);
        else if (number >= TWO_63) {
          state.out += formatInteger(toUnsignedLong(number), "u", numeric, width ?? 0, precision);
        } else state.out += formatInteger(toLong(number), "d", numeric, width ?? 0, precision);
        break;
      }
      case "o":
      case "x":
      case "X":
        state.out += formatInteger(
          toUnsignedLong(convert.number(value)),
          conversion,
          numeric,
          width ?? 0,
          precision,
        );
        break;
      case "u": {
        const number = convert.number(value);
        if (number === TWO_63 || number === TWO_64) state.out += boundText(number);
        else
          state.out += formatInteger(toUnsignedLong(number), "u", numeric, width ?? 0, precision);
        break;
      }
      case "e":
      case "E":
      case "f":
      case "g":
      case "G":
        if (longs > 0) throw bad();
        state.out += formatFloat(
          convert.number(value),
          floatConversion(conversion),
          numeric,
          width ?? 0,
          precision,
        );
        break;
      default:
        throw bad();
    }
  }
}

function floatConversion(conversion: string): FloatConversion {
  switch (conversion) {
    case "e":
      return "e";
    case "E":
      return "E";
    case "f":
      return "f";
    case "G":
      return "G";
    default:
      return "g";
  }
}

const NUMBER_CONVERTER: Converter = {
  number: (value) => (typeof value === "number" ? value : 0),
  text: (value) => (typeof value === "string" ? value : ""),
  guard: () => {},
};

/** CONVFMT or OFMT applied to one number. */
export function formatSingleNumber(format: string, value: number): string {
  if (format === "%.6g") return formatFloat(value, "g", NO_FLAGS, 0, 6);
  try {
    return sprintf("sprintf", format, [value], NUMBER_CONVERTER);
  } catch (error) {
    if (error instanceof FormatError) return formatFloat(value, "g", NO_FLAGS, 0, 6);
    throw error;
  }
}
