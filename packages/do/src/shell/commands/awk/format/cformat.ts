// C `printf` conversions for doubles and 64-bit integers.
//
// awk formats numbers as C's printf does, so `%.6g`, `%e`, and `%f` must round
// exactly as glibc does: from the double's exact binary value, ties to even.
// JS `toFixed`/`toPrecision` round ties away from zero, so the digits come
// from an exact BigInt expansion instead.

export interface ConversionFlags {
  readonly minus: boolean;
  readonly plus: boolean;
  readonly space: boolean;
  readonly alternate: boolean;
  readonly zero: boolean;
}

export const NO_FLAGS: ConversionFlags = {
  minus: false,
  plus: false,
  space: false,
  alternate: false,
  zero: false,
};

/** `0.<digits> × 10^point`; `digits` has no leading or trailing zeros. */
interface Decimal {
  readonly digits: string;
  readonly point: number;
}

const VIEW = new DataView(new ArrayBuffer(8));

function exactDecimal(value: number): Decimal {
  if (value === 0) return { digits: "", point: 0 };
  VIEW.setFloat64(0, value);
  const high = VIEW.getUint32(0);
  const low = VIEW.getUint32(4);
  const exponentBits = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  let exponent = -1074;
  if (exponentBits !== 0) {
    mantissa |= 1n << 52n;
    exponent = exponentBits - 1075;
  }
  let text: string;
  let point: number;
  if (exponent >= 0) {
    text = (mantissa << BigInt(exponent)).toString();
    point = text.length;
  } else {
    text = (mantissa * 5n ** BigInt(-exponent)).toString();
    point = text.length + exponent;
  }
  return { digits: text.replace(/0+$/, ""), point };
}

/** Keep `keep` leading digits, rounding half to even on the exact value. */
function roundDigits(decimal: Decimal, keep: number): Decimal {
  const { digits, point } = decimal;
  if (keep >= digits.length) return { digits: digits.padEnd(keep, "0"), point };
  if (keep < 0) return { digits: "", point: point - keep };
  const next = digits.charCodeAt(keep) - 48;
  const beyond = digits.length > keep + 1;
  const last = keep > 0 ? digits.charCodeAt(keep - 1) - 48 : 0;
  const up = next > 5 || (next === 5 && (beyond || last % 2 === 1));
  const kept = digits.slice(0, keep);
  if (!up) return { digits: kept, point };
  let index = kept.length - 1;
  while (index >= 0 && kept.charAt(index) === "9") index--;
  if (index < 0) return { digits: `1${"0".repeat(kept.length)}`, point: point + 1 };
  const bumped = String.fromCharCode(kept.charCodeAt(index) + 1);
  return {
    digits: `${kept.slice(0, index)}${bumped}${"0".repeat(kept.length - index - 1)}`,
    point,
  };
}

function fixedParts(value: number, precision: number): { integer: string; fraction: string } {
  const exact = exactDecimal(value);
  const rounded = roundDigits(exact, exact.point + precision);
  const { digits, point } = rounded;
  const integer =
    point > 0
      ? digits
          .slice(0, point)
          .padEnd(point, "0")
          .replace(/^0+(?=.)/, "")
      : "0";
  const tail = point >= 0 ? digits.slice(point) : `${"0".repeat(-point)}${digits}`;
  return { integer, fraction: tail.padEnd(precision, "0").slice(0, precision) };
}

function exponentParts(
  value: number,
  precision: number,
): { lead: string; fraction: string; exponent: number } {
  if (value === 0) return { lead: "0", fraction: "0".repeat(precision), exponent: 0 };
  const rounded = roundDigits(exactDecimal(value), precision + 1);
  const digits = rounded.digits.slice(0, precision + 1);
  return { lead: digits.charAt(0), fraction: digits.slice(1), exponent: rounded.point - 1 };
}

function exponentText(exponent: number, upper: boolean): string {
  const magnitude = Math.abs(exponent).toString().padStart(2, "0");
  return `${upper ? "E" : "e"}${exponent < 0 ? "-" : "+"}${magnitude}`;
}

function signOf(negative: boolean, flags: ConversionFlags): string {
  if (negative) return "-";
  if (flags.plus) return "+";
  if (flags.space) return " ";
  return "";
}

/** Width padding: spaces left or right, or zeros between the sign and the body. */
export function pad(
  prefix: string,
  body: string,
  flags: ConversionFlags,
  width: number,
  zeroAllowed: boolean,
): string {
  const length = prefix.length + body.length;
  if (length >= width) return `${prefix}${body}`;
  const fill = width - length;
  if (flags.minus) return `${prefix}${body}${" ".repeat(fill)}`;
  if (flags.zero && zeroAllowed) return `${prefix}${"0".repeat(fill)}${body}`;
  return `${" ".repeat(fill)}${prefix}${body}`;
}

export type FloatConversion = "e" | "E" | "f" | "F" | "g" | "G";

export function formatFloat(
  value: number,
  conversion: FloatConversion,
  flags: ConversionFlags,
  width: number,
  precisionOrNull: number | null,
): string {
  const negative = value < 0 || Object.is(value, -0);
  const sign = signOf(negative, flags);
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude)) {
    const name = Number.isNaN(magnitude) ? "nan" : "inf";
    const text = conversion === conversion.toUpperCase() ? name.toUpperCase() : name;
    return pad(sign, text, flags, width, false);
  }
  const precision = precisionOrNull ?? 6;
  const upper = conversion === "E" || conversion === "G";
  let body: string;
  if (conversion === "f" || conversion === "F") {
    const { integer, fraction } = fixedParts(magnitude, precision);
    body = precision > 0 || flags.alternate ? `${integer}.${fraction}` : integer;
  } else if (conversion === "e" || conversion === "E") {
    const { lead, fraction, exponent } = exponentParts(magnitude, precision);
    const point = precision > 0 || flags.alternate ? "." : "";
    body = `${lead}${point}${fraction}${exponentText(exponent, upper)}`;
  } else {
    body = generalBody(magnitude, precision === 0 ? 1 : precision, flags.alternate, upper);
  }
  return pad(sign, body, flags, width, true);
}

function generalBody(value: number, precision: number, alternate: boolean, upper: boolean): string {
  const probe = exponentParts(value, precision - 1);
  const exponent = probe.exponent;
  let body: string;
  if (exponent < precision && exponent >= -4) {
    const fractionDigits = precision - 1 - exponent;
    const { integer, fraction } = fixedParts(value, fractionDigits);
    body = fractionDigits > 0 || alternate ? `${integer}.${fraction}` : integer;
    if (!alternate && body.includes(".")) body = body.replace(/\.?0+$/, "");
    return body;
  }
  let fraction = probe.fraction;
  if (!alternate) fraction = fraction.replace(/0+$/, "");
  const point = fraction.length > 0 || alternate ? "." : "";
  return `${probe.lead}${point}${fraction}${exponentText(exponent, upper)}`;
}

export type IntegerConversion = "d" | "i" | "u" | "o" | "x" | "X";

/** An integer conversion of an exact integer value (already clamped by the caller). */
export function formatInteger(
  value: bigint,
  conversion: IntegerConversion,
  flags: ConversionFlags,
  width: number,
  precision: number | null,
): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const signed = conversion === "d" || conversion === "i";
  let digits: string;
  if (conversion === "o") digits = magnitude.toString(8);
  else if (conversion === "x") digits = magnitude.toString(16);
  else if (conversion === "X") digits = magnitude.toString(16).toUpperCase();
  else digits = magnitude.toString();
  if (precision !== null) {
    digits = precision === 0 && magnitude === 0n ? "" : digits.padStart(precision, "0");
  }
  let prefix = signed ? signOf(negative, flags) : "";
  if (flags.alternate) {
    if (conversion === "o" && !digits.startsWith("0")) digits = `0${digits}`;
    if (conversion === "x" && magnitude !== 0n) prefix = "0x";
    if (conversion === "X" && magnitude !== 0n) prefix = "0X";
  }
  return pad(prefix, digits, flags, width, precision === null);
}
