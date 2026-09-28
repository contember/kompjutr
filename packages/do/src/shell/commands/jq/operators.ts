// jq's binary operators (binop_* in src/builtin.c) with their type rules and
// their exact error texts.

import { compareValues, equalValues } from "./compare.js";
import { JqError, typeError2 } from "./errors.js";
import { arrayBytes, type Charge, objectBytes, stringBytes } from "./paths.js";
import { knownSize } from "./runtime.js";
import type { BinaryOperator } from "./syntax/ast.js";
import { isArray, isNumber, isObject, type JqObject, type JqValue, numberValue } from "./value.js";

const INT_MAX = 2_147_483_647;

export function binary(
  operator: BinaryOperator,
  left: JqValue,
  right: JqValue,
  charge: Charge,
): JqValue {
  switch (operator) {
    case "+":
      return plus(left, right, charge);
    case "-":
      return minus(left, right, charge);
    case "*":
      return multiply(left, right, charge);
    case "/":
      return divide(left, right, charge);
    case "%":
      return modulo(left, right);
    case "==":
      return equalValues(left, right);
    case "!=":
      return !equalValues(left, right);
    case "<":
      return compareValues(left, right) < 0;
    case "<=":
      return compareValues(left, right) <= 0;
    case ">":
      return compareValues(left, right) > 0;
    case ">=":
      return compareValues(left, right) >= 0;
  }
}

export function plus(left: JqValue, right: JqValue, charge: Charge): JqValue {
  if (left === null) return right;
  if (right === null) return left;
  if (isNumber(left) && isNumber(right)) return numberValue(left) + numberValue(right);
  if (typeof left === "string" && typeof right === "string") {
    charge(stringBytes(left) + stringBytes(right));
    return left + right;
  }
  if (isArray(left) && isArray(right)) {
    charge(arrayBytes(left.length + right.length));
    const joined = left.concat(right);
    knownSize(joined, left, right);
    return joined;
  }
  if (isObject(left) && isObject(right)) {
    const out = new Map(left);
    for (const [key, value] of right) out.set(key, value);
    charge(objectBytes(out.size));
    return out;
  }
  throw typeError2(left, right, "cannot be added");
}

function minus(left: JqValue, right: JqValue, charge: Charge): JqValue {
  if (isNumber(left) && isNumber(right)) return numberValue(left) - numberValue(right);
  if (isArray(left) && isArray(right)) {
    charge(arrayBytes(left.length));
    return left.filter((item) => !right.some((other) => equalValues(item, other)));
  }
  throw typeError2(left, right, "cannot be subtracted");
}

function multiply(left: JqValue, right: JqValue, charge: Charge): JqValue {
  if (isNumber(left) && isNumber(right)) return numberValue(left) * numberValue(right);
  if (typeof left === "string" && isNumber(right)) return repeat(left, numberValue(right), charge);
  if (isNumber(left) && typeof right === "string") return repeat(right, numberValue(left), charge);
  if (isObject(left) && isObject(right)) return deepMerge(left, right, charge);
  throw typeError2(left, right, "cannot be multiplied");
}

function repeat(text: string, times: number, charge: Charge): JqValue {
  const count =
    times < 0 || Number.isNaN(times) ? -1 : times > INT_MAX ? INT_MAX : Math.trunc(times);
  if (count < 0) return null;
  const bytes = new TextEncoder().encode(text).length * count;
  if (bytes >= INT_MAX) throw new JqError("Repeat string result too long");
  charge(16 + 2 * text.length * count);
  return text.repeat(count);
}

function deepMerge(left: JqObject, right: JqObject, charge: Charge): JqObject {
  const out = new Map(left);
  for (const [key, value] of right) {
    const existing = out.get(key);
    if (existing !== undefined && isObject(existing) && isObject(value)) {
      out.set(key, deepMerge(existing, value, charge));
    } else out.set(key, value);
  }
  charge(objectBytes(out.size));
  return out;
}

function divide(left: JqValue, right: JqValue, charge: Charge): JqValue {
  if (isNumber(left) && isNumber(right)) {
    if (numberValue(right) === 0) {
      throw typeError2(left, right, "cannot be divided because the divisor is zero");
    }
    return numberValue(left) / numberValue(right);
  }
  if (typeof left === "string" && typeof right === "string")
    return splitString(left, right, charge);
  throw typeError2(left, right, "cannot be divided");
}

/** jv_string_split: an empty separator splits into code points. */
export function splitString(text: string, separator: string, charge: Charge): JqValue[] {
  charge(stringBytes(text) * 2);
  if (separator === "") return Array.from(text);
  const parts: JqValue[] = [];
  let at = 0;
  while (at < text.length) {
    const found = text.indexOf(separator, at);
    const end = found === -1 ? text.length : found;
    parts.push(text.slice(at, end));
    if (found !== -1 && found + separator.length === text.length) parts.push("");
    at = end + separator.length;
  }
  return parts;
}

const INTMAX_MIN = -(2n ** 63n);
const INTMAX_MAX = 2n ** 63n - 1n;

/** C's intmax_t conversion as binop_mod clamps it. */
function toIntmax(value: number): bigint {
  if (value < -(2 ** 63)) return INTMAX_MIN;
  if (-value < -(2 ** 63)) return INTMAX_MAX;
  return BigInt(Math.trunc(value));
}

function modulo(left: JqValue, right: JqValue): JqValue {
  if (!isNumber(left) || !isNumber(right))
    throw typeError2(left, right, "cannot be divided (remainder)");
  const dividend = numberValue(left);
  const divisor = numberValue(right);
  if (Number.isNaN(dividend) || Number.isNaN(divisor)) return Number.NaN;
  const bigDivisor = toIntmax(divisor);
  if (bigDivisor === 0n) {
    throw typeError2(left, right, "cannot be divided (remainder) because the divisor is zero");
  }
  if (bigDivisor === -1n) return 0;
  return Number(toIntmax(dividend) % bigDivisor);
}
