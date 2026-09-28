// `seq -f FORMAT` and the default number layout, as uucore's float formatter
// renders an exact decimal: `%f` rounds half to even, `%e` and `%g` round half
// up (BigDecimal's `with_prec`). One float directive, `%%` escapes, and the
// directive errors in the reference's words. `%a` is refused.

import type { Decimal } from "./seq-number.js";

export class FormatError extends Error {}
export class FormatRefusal extends Error {}

type Variant = "decimal" | "scientific" | "shortest";
type Alignment = "left" | "right-space" | "right-zero";

export interface FloatSpec {
  readonly variant: Variant;
  readonly uppercase: boolean;
  readonly forceDecimal: boolean;
  readonly width: number;
  readonly precision: number | null;
  readonly alignment: Alignment;
  readonly positiveSign: "" | "+" | " ";
}

export interface Format {
  readonly prefix: string;
  readonly spec: FloatSpec;
  readonly suffix: string;
}

export function parseFormat(format: string): Format {
  let prefix = "";
  let cursor = 0;
  let spec: FloatSpec | null = null;
  while (cursor < format.length) {
    if (format[cursor] !== "%") {
      prefix += format[cursor];
      cursor++;
      continue;
    }
    if (cursor === format.length - 1) throw new FormatError(`format ${quoted(format)} ends in %`);
    if (format[cursor + 1] === "%") {
      prefix += "%";
      cursor += 2;
      continue;
    }
    const parsed = parseSpec(format, cursor + 1);
    spec = toFloat(parsed.spec);
    cursor = parsed.next;
    break;
  }
  if (spec === null) throw new FormatError(`format '${format}' has no % directive`);
  let suffix = "";
  while (cursor < format.length) {
    if (format[cursor] !== "%") {
      suffix += format[cursor];
      cursor++;
      continue;
    }
    if (cursor === format.length - 1 || format[cursor + 1] !== "%") {
      if (cursor < format.length - 1) parseSpec(format, cursor + 1);
      throw new FormatError(`format '${format}' has too many % directives`);
    }
    suffix += "%";
    cursor += 2;
  }
  return { prefix, spec, suffix };
}

function quoted(text: string): string {
  return text.includes("'") ? `"${text}"` : `'${text}'`;
}

interface RawSpec {
  readonly flags: string;
  readonly width: number | "*" | null;
  readonly precision: number | "*" | null;
  readonly conversion: string;
}

/** uucore's `Spec::parse`: `%[N$][flags][width][.precision][length]conversion`. */
function parseSpec(format: string, start: number): { spec: RawSpec; next: number } {
  let index = start;
  const fail = (): FormatError =>
    new FormatError(`%${format.slice(start, index)}: invalid conversion specification`);
  const number = (): number | null => {
    const digits = /^[0-9]+/.exec(format.slice(index))?.[0];
    if (digits === undefined) return null;
    index += digits.length;
    return Number(digits);
  };
  const position = index;
  const argument = number();
  if (argument !== null && format[index] === "$") {
    index++;
    if (argument === 0) throw fail();
  } else {
    index = position;
  }
  let flags = "";
  while (index < format.length && "-+ #0'".includes(format.charAt(index))) {
    flags += format.charAt(index);
    index++;
  }
  const starOrNumber = (): number | "*" | null => {
    if (format[index] !== "*") return number();
    index++;
    return "*";
  };
  const width = starOrNumber();
  let precision: number | "*" | null = null;
  if (format[index] === ".") {
    index++;
    precision = starOrNumber() ?? 0;
  }
  while (index < format.length && "hljztL".includes(format.charAt(index))) index++;
  const conversion = format.charAt(index);
  if (conversion === "") throw fail();
  index++;
  const any = flags !== "" || width !== null || precision !== null;
  const invalid =
    (conversion === "c" && (flags.includes("0") || flags.includes("#") || precision !== null)) ||
    (conversion === "s" && /[0#']/.test(flags)) ||
    ((conversion === "b" || conversion === "q") && any) ||
    ((conversion === "d" || conversion === "i" || conversion === "u") && flags.includes("#")) ||
    !"csbqdiuoxXfFeEgGaA".includes(conversion);
  if (invalid) throw fail();
  return { spec: { flags, width, precision, conversion }, next: index };
}

function toFloat(spec: RawSpec): FloatSpec {
  const variant: Variant | null = "fF".includes(spec.conversion)
    ? "decimal"
    : "eE".includes(spec.conversion)
      ? "scientific"
      : "gG".includes(spec.conversion)
        ? "shortest"
        : null;
  if ("aA".includes(spec.conversion)) throw new FormatRefusal(`the %${spec.conversion} directive`);
  if (variant === null || spec.width === "*" || spec.precision === "*") {
    throw new FormatError("wrong % directive type was given");
  }
  const minus = spec.flags.includes("-");
  return {
    variant,
    uppercase: spec.conversion === spec.conversion.toUpperCase(),
    forceDecimal: spec.flags.includes("#"),
    width: spec.width ?? 0,
    precision: spec.precision,
    alignment: minus ? "left" : spec.flags.includes("0") ? "right-zero" : "right-space",
    positiveSign: spec.flags.includes("+") ? "+" : spec.flags.includes(" ") ? " " : "",
  };
}

export function render(format: Format, value: Decimal): string {
  return `${format.prefix}${renderFloat(format.spec, value)}${format.suffix}`;
}

function renderFloat(spec: FloatSpec, value: Decimal): string {
  const negative = value.units < 0n || value.negativeZero;
  const magnitude = value.units < 0n ? -value.units : value.units;
  let body: string;
  if (spec.variant === "decimal") body = decimal(magnitude, value.scale, spec);
  else if (spec.variant === "scientific") body = scientific(magnitude, value.scale, spec);
  else body = shortest(magnitude, value.scale, spec);
  const sign = negative ? "-" : spec.positiveSign;
  if (spec.width === 0) return `${sign}${body}`;
  const room = spec.width - Math.min(spec.width, sign.length);
  if (spec.alignment === "left") return `${sign}${body.padEnd(room)}`;
  if (spec.alignment === "right-zero") return `${sign}${body.padStart(room, "0")}`;
  if ((sign === "-" || sign === "+") && room > 0) return `${sign}${body}`.padStart(room + 1);
  return `${sign}${body.padStart(room)}`;
}

function decimal(units: bigint, scale: number, spec: FloatSpec): string {
  const precision = spec.precision ?? 6;
  if (precision === 0 && scale === 0 && !spec.forceDecimal) return units.toString();
  const rounded = rescaleHalfEven(units, scale, precision);
  const text = rounded.toString().padStart(precision + 1, "0");
  const whole = text.slice(0, text.length - precision);
  if (precision === 0) return spec.forceDecimal ? `${whole}.` : whole;
  return `${whole}.${text.slice(text.length - precision)}`;
}

/** `units / 10^scale` at `precision` decimals, ties to even. */
function rescaleHalfEven(units: bigint, scale: number, precision: number): bigint {
  if (precision >= scale) return units * 10n ** BigInt(precision - scale);
  const divisor = 10n ** BigInt(scale - precision);
  const quotient = units / divisor;
  const twice = (units % divisor) * 2n;
  if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) return quotient + 1n;
  return quotient;
}

/** `precision` significant digits, ties away from zero, and the decimal exponent. */
function significant(
  units: bigint,
  scale: number,
  precision: number,
): { digits: string; exponent: number } {
  let digits = units.toString();
  let newScale = scale;
  if (digits.length > precision) {
    const drop = digits.length - precision;
    const divisor = 10n ** BigInt(drop);
    let quotient = units / divisor;
    if ((units % divisor) * 2n >= divisor) quotient += 1n;
    digits = quotient.toString();
    newScale -= drop;
    if (digits.length === precision + 1) {
      digits = digits.slice(0, precision);
      newScale -= 1;
    }
  } else if (digits.length < precision) {
    newScale += precision - digits.length;
    digits = digits.padEnd(precision, "0");
  }
  return { digits, exponent: -newScale + precision - 1 };
}

function exponentText(exponent: number, uppercase: boolean): string {
  const sign = exponent < 0 ? "-" : "+";
  return `${uppercase ? "E" : "e"}${sign}${Math.abs(exponent).toString().padStart(2, "0")}`;
}

function scientific(units: bigint, scale: number, spec: FloatSpec): string {
  const precision = spec.precision ?? 6;
  if (units === 0n) {
    const zero = spec.forceDecimal && precision === 0 ? "0." : (0).toFixed(precision);
    return `${zero}${exponentText(0, spec.uppercase)}`;
  }
  const { digits, exponent } = significant(units, scale, precision + 1);
  const rest = digits.slice(1);
  const dot = rest !== "" || (precision === 0 && spec.forceDecimal) ? "." : "";
  return `${digits.slice(0, 1)}${dot}${rest}${exponentText(exponent, spec.uppercase)}`;
}

function shortest(units: bigint, scale: number, spec: FloatSpec): string {
  const precision = Math.max(1, spec.precision ?? 6);
  if (units === 0n) {
    if (!spec.forceDecimal) return "0";
    return precision === 1 ? "0." : (0).toFixed(precision - 1);
  }
  const { digits, exponent } = significant(units, scale, precision);
  let output: string;
  if (exponent < -4 || exponent >= precision) {
    output = `${digits.slice(0, 1)}.${digits.slice(1)}`;
    if (!spec.forceDecimal) output = stripZeros(output);
    return `${output}${exponentText(exponent, spec.uppercase)}`;
  }
  if (exponent < 0) {
    output = `0.${"0".repeat(-exponent - 1)}${digits}`;
  } else {
    output = `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
  }
  return spec.forceDecimal ? output : stripZeros(output);
}

function stripZeros(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}
