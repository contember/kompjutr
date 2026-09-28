// The argument grammars of find's valued primaries: `-size`, the `-mmin` and
// `-mtime` ages, and `-exec`'s command up to its terminator. Messages are
// GNU findutils' own.

import { UsageError } from "../flags.js";
import { type Comparison, type Expression, FindUsageError } from "./types.js";

const SIZE_UNITS: ReadonlyMap<string, number> = new Map([
  ["c", 1],
  ["w", 2],
  ["b", 512],
  ["k", 1024],
  ["M", 1024 ** 2],
  ["G", 1024 ** 3],
]);

/** GNU reads the unit from the last character before it reads the number. */
export function parseSize(value: string): Expression {
  if (value === "") throw new FindUsageError("invalid null argument to -size");
  const suffix = value.charAt(value.length - 1);
  let unit = 512;
  let body = value;
  if (!/[0-9]/.test(suffix)) {
    const named = SIZE_UNITS.get(suffix);
    if (named === undefined) throw new FindUsageError(`invalid -size type \`${suffix}'`);
    unit = named;
    body = value.slice(0, -1);
  }
  const match = /^([+-]?)([0-9]+)$/.exec(body);
  if (match === null) throw new FindUsageError(`Invalid argument \`${value}' to -size`);
  return {
    kind: "size",
    comparison: comparisonOf(match[1] ?? ""),
    count: Number(match[2]),
    unit,
  };
}

export function parseAge(name: "-mmin" | "-mtime", value: string): Expression {
  const match = /^([+-]?)([0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.exec(value);
  if (match === null) throw new FindUsageError(`invalid argument \`${value}' to \`${name}'`);
  return {
    kind: "age",
    comparison: comparisonOf(match[1] ?? ""),
    amount: Number(match[2]),
    unit: name === "-mmin" ? "minutes" : "days",
  };
}

/**
 * `-exec` arguments from `start` up to `;`, or up to a `+` that directly
 * follows `{}`. Anywhere else `+` is an ordinary argument, as in GNU.
 */
export function parseExec(
  args: readonly string[],
  start: number,
): { readonly node: Expression; readonly next: number } {
  for (let index = start; index < args.length; index++) {
    const arg = args[index];
    if (arg === ";") {
      const argv = args.slice(start, index);
      if (argv.length === 0) throw new FindUsageError("invalid argument `;' to `-exec'");
      return { node: { kind: "exec", batched: false, argv }, next: index + 1 };
    }
    if (arg === "+" && index > start && args[index - 1] === "{}") {
      const argv = args.slice(start, index - 1);
      // GNU would take the first path as the command; nothing asks for that.
      if (argv.length === 0) throw new UsageError("-exec {} + without a command is not supported");
      if (argv.some((part) => part.includes("{}"))) {
        throw new FindUsageError("Only one instance of {} is supported with -exec ... +");
      }
      return { node: { kind: "exec", batched: true, argv }, next: index + 1 };
    }
  }
  throw new FindUsageError("missing argument to `-exec'");
}

function comparisonOf(sign: string): Comparison {
  if (sign === "+") return "greater";
  if (sign === "-") return "less";
  return "equal";
}
