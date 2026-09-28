// seq's numbers: exact decimals, as uutils seq keeps them (arbitrary-precision
// BigDecimal), so `seq 0.1 0.1 0.3` never drifts. A value is `units / 10^scale`.
// The parse also reports the integral and fractional widths the reference
// derives from the spelling, which pick the default precision and `-w` width.

import { ShellLimitError } from "../../exec/context.js";

export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
  /** `-0` and `-0.0` print their sign, as the reference's MinusZero does. */
  readonly negativeZero: boolean;
}

export interface PreciseNumber {
  readonly value: Decimal;
  readonly integralDigits: number;
  readonly fractionalDigits: number;
}

export type NumberProblem = "float" | "nan" | "unsupported";

const DECIMAL = /^([+-])?([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/;
const I64_LIMIT = 2n ** 63n;

/** `maxDigits` is the retained budget left: `1e999999999` would need that many digits. */
export function parseNumber(input: string, maxDigits: number): PreciseNumber | NumberProblem {
  const text = input.trimStart();
  const lower = text.toLowerCase();
  const unsigned = lower.replace(/^[+-]/, "");
  if (unsigned === "nan") return "nan";
  if (unsigned === "inf" || unsigned === "infinity" || unsigned.startsWith("0x")) {
    return "unsupported";
  }
  const match = DECIMAL.exec(text);
  if (match === null) return "float";
  const [, sign, whole = "", fraction, exponentText] = match;
  if (whole === "" && (fraction === undefined || fraction === "")) return "float";
  const exponent = exponentText === undefined ? 0n : BigInt(exponentText);
  if (exponent >= I64_LIMIT || exponent < -I64_LIMIT) return "float";
  const digits = `${whole}${fraction ?? ""}`;
  let units = BigInt(digits === "" ? "0" : digits);
  let scale = BigInt((fraction ?? "").length) - exponent;
  if (scale < -BigInt(maxDigits) || scale > BigInt(maxDigits)) {
    throw new ShellLimitError(
      "retained",
      `seq operand '${input}' exceeds the retained-memory limit`,
    );
  }
  if (scale < 0n) {
    units *= 10n ** -scale;
    scale = 0n;
  }
  const negative = sign === "-";
  const value: Decimal = {
    units: negative ? -units : units,
    scale: Number(scale),
    negativeZero: negative && units === 0n,
  };
  return { value, ...spelledWidths(lower.replace(/^\+/, ""), Number(exponent)) };
}

/** The reference's reading of widths from the spelling, sign included. */
function spelledWidths(
  spelling: string,
  exponent: number,
): { integralDigits: number; fractionalDigits: number } {
  const mantissa = spelling.split("e")[0] ?? "";
  const dot = mantissa.indexOf(".");
  let integralDigits: number;
  let fractionalDigits: number;
  if (dot === -1) {
    integralDigits = mantissa.length;
    fractionalDigits = 0;
  } else {
    integralDigits = dot === 0 ? 1 : dot === 1 && mantissa.startsWith("-") ? 2 : dot;
    fractionalDigits = mantissa.length - dot - 1;
  }
  if (spelling.includes("e")) {
    if (exponent > 0) integralDigits += exponent;
    fractionalDigits = exponent < fractionalDigits ? fractionalDigits - exponent : 0;
  }
  return { integralDigits, fractionalDigits };
}

export const ONE: PreciseNumber = {
  value: { units: 1n, scale: 0, negativeZero: false },
  integralDigits: 1,
  fractionalDigits: 0,
};

export function isZero(value: Decimal): boolean {
  return value.units === 0n;
}

/** Both at the larger scale, so they add and compare as integers. */
export function aligned(value: Decimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

export function digitCount(value: bigint): number {
  return (value < 0n ? -value : value).toString().length;
}
