// Builtin functions, with the argument conversions and edge cases mawk shows.

import { AwkRuntimeError } from "./errors.js";
import type { Evaluator } from "./evaluate.js";
import { splitText } from "./fields.js";
import { type Converter, FormatError, sprintf } from "./format/format.js";
import type { Expr, LValue, Slot } from "./parse/ast.js";
import type { Regex } from "./regex/regex.js";
import { ELEMENT_OVERHEAD, type Runtime } from "./runtime.js";
import { byteLength, maybeNumber, toNumber, toText, type Value } from "./values.js";

/** Positions as mawk treats them: truncated, then wrapped to a 32-bit C `int` (so 2^40 is 0). */
function toCInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (Math.abs(value) < 2 ** 31) return Math.trunc(value);
  const clamped =
    value >= 2 ** 63
      ? 2n ** 63n - 1n
      : value <= -(2 ** 63)
        ? -(2n ** 63n - 1n)
        : BigInt(Math.trunc(value));
  return Number(BigInt.asIntN(32, clamped));
}

function asciiCase(text: string, upper: boolean): string {
  return upper
    ? text.replace(/[a-z]+/g, (run) => run.toUpperCase())
    : text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

export function converter(runtime: Runtime): Converter {
  return {
    number: toNumber,
    text: (value) => toText(value, runtime),
    guard: (bytes) => {
      if (bytes > 4096) runtime.budget.retain(bytes, "awk printf field")();
    },
  };
}

/** `printf` output keeps what was written before a failing conversion. */
export function formatted(
  runtime: Runtime,
  who: "printf" | "sprintf",
  args: readonly Value[],
): string {
  const [format, ...rest] = args;
  try {
    return sprintf(who, toText(format ?? null, runtime), rest, converter(runtime));
  } catch (error) {
    if (error instanceof FormatError) {
      if (who === "printf") runtime.output.write(error.partial);
      throw new AwkRuntimeError(error.message);
    }
    throw error;
  }
}

function substr(text: string, startValue: number, lengthValue: number | null): string {
  const length = text.length;
  if (length === 0) return "";
  let count = lengthValue === null ? length : toCInt(lengthValue);
  let start = toCInt(startValue) - 1;
  if (start > length) count = 0;
  if (start < 0) {
    count -= start + 1;
    start = 0;
  }
  if (count > length - start) count = length - start;
  return count <= 0 ? "" : text.slice(start, start + count);
}

export function callBuiltin(evaluator: Evaluator, name: string, argExprs: readonly Expr[]): Value {
  const runtime = evaluator.runtime;
  const args = argExprs.map((arg) => evaluator.evaluate(arg));
  const text = (index: number): string => toText(args[index] ?? null, runtime);
  const number = (index: number): number => toNumber(args[index] ?? null);
  switch (name) {
    case "length":
      return text(0).length;
    case "index": {
      const needle = text(1);
      return needle.length === 0 ? 1 : text(0).indexOf(needle) + 1;
    }
    case "substr":
      return substr(text(0), number(1), args.length > 2 ? number(2) : null);
    case "sprintf":
      return formatted(runtime, "sprintf", args);
    case "sin":
      return Math.sin(number(0));
    case "cos":
      return Math.cos(number(0));
    case "atan2":
      return Math.atan2(number(0), number(1));
    case "exp":
      return Math.exp(number(0));
    case "log":
      return Math.log(number(0));
    case "sqrt":
      return Math.sqrt(number(0));
    case "int":
      return Math.trunc(number(0));
    case "toupper":
      return asciiCase(text(0), true);
    case "tolower":
      return asciiCase(text(0), false);
    case "fflush": {
      if (args.length === 0) return 0;
      const target = text(0);
      return target === "" || target === "/dev/stdout" ? 0 : -1;
    }
    default:
      throw new AwkRuntimeError(`function ${name} never defined`);
  }
}

export function matchFunction(evaluator: Evaluator, subjectExpr: Expr, patternExpr: Expr): Value {
  const runtime = evaluator.runtime;
  const subject = toText(evaluator.evaluate(subjectExpr), runtime);
  const regex = evaluator.regexOf(patternExpr);
  const { match } = regex.search(subject, 0, true, true);
  const start = match === null ? 0 : match.start + 1;
  runtime.setSpecial("RSTART", start);
  runtime.setSpecial("RLENGTH", match === null ? -1 : match.end - match.start);
  return start;
}

export function split(
  evaluator: Evaluator,
  sourceExpr: Expr,
  slot: Slot,
  separator: Expr | null,
): Value {
  const runtime = evaluator.runtime;
  const source = toText(evaluator.evaluate(sourceExpr), runtime);
  const array = evaluator.array(slot);
  let pieces: string[];
  if (separator === null) pieces = splitText(source, runtime.splitter);
  else if (separator.kind === "regex") {
    pieces = splitText(source, { kind: "regex", regex: runtime.regex(separator.source) });
  } else pieces = splitText(source, runtime.splitterFor(evaluator.evaluate(separator)));
  runtime.clearArray(array);
  const values = pieces.map((piece) => maybeNumber(piece));
  let bytes = 0;
  for (const value of values) bytes += byteLength(value) + ELEMENT_OVERHEAD + 8;
  runtime.charge(array, bytes);
  array.load(values);
  return pieces.length;
}

type ReplacementPart = string | null;

/** Replacement text: `&` is the match, `\&` a literal `&`, `\\&` a backslash then the match. */
function replacementParts(text: string): ReplacementPart[] {
  const parts: ReplacementPart[] = [];
  let literal = "";
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      const next = text.charAt(index + 1);
      if (next === "\\") {
        let cursor = index + 2;
        while (text.charAt(cursor) === "\\") cursor++;
        if (text.charAt(cursor) === "&") {
          literal += "\\";
          index += 2;
        } else {
          literal += "\\\\";
          index += 2;
        }
        continue;
      }
      if (next === "&") {
        literal += "&";
        index += 2;
        continue;
      }
      literal += "\\";
      index++;
      continue;
    }
    if (char === "&") {
      if (literal !== "") parts.push(literal);
      literal = "";
      parts.push(null);
      index++;
      continue;
    }
    literal += char;
    index++;
  }
  if (literal !== "" || parts.length === 0) parts.push(literal);
  return parts;
}

function expand(parts: readonly ReplacementPart[], matched: string): string {
  let out = "";
  for (const part of parts) out += part ?? matched;
  return out;
}

export function substitute(
  evaluator: Evaluator,
  global: boolean,
  patternExpr: Expr,
  replacementExpr: Expr,
  target: LValue,
): Value {
  const runtime = evaluator.runtime;
  const regex = evaluator.regexOf(patternExpr);
  const parts = replacementParts(toText(evaluator.evaluate(replacementExpr), runtime));
  const place = evaluator.locate(target);
  const input = toText(place.get(), runtime);
  if (!global) {
    const { match } = regex.search(input, 0, true, true);
    if (match === null) return 0;
    const matched = input.slice(match.start, match.end);
    place.set(`${input.slice(0, match.start)}${expand(parts, matched)}${input.slice(match.end)}`);
    return 1;
  }
  const { output, count } = globalSubstitute(regex, input, parts);
  if (count > 0) place.set(output);
  return count;
}

/** Global substitution: an empty match right after a non-empty one is skipped. */
function globalSubstitute(
  regex: Regex,
  input: string,
  parts: readonly ReplacementPart[],
): { output: string; count: number } {
  let output = "";
  let count = 0;
  let skip = -1;
  for (let index = 0; index <= input.length; index++) {
    const { match } = regex.search(input, index, index === 0, true);
    if (match === null) {
      output += input.slice(index);
      break;
    }
    if (match.start > index) {
      skip = -1;
      output += input.slice(index, match.start);
    }
    const length = match.end - match.start;
    if (length > 0 || match.start !== skip) {
      count++;
      output += expand(parts, input.slice(match.start, match.end));
    }
    if (length > 0) {
      index = match.end - 1;
      skip = match.end;
    } else {
      index = match.start;
      if (index < input.length) output += input.charAt(index);
      skip = -1;
    }
  }
  return { output, count };
}
