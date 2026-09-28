// `test` and `[`. Dispatch follows POSIX by argument count, as Bash does, so
// `test -f` is a non-empty string and `test ! -f x` negates a file test.
// More than four arguments needs Bash's `-a`/`-o` precedence rules, and the
// few file tests without a meaning here fail by name instead of answering.
// Each file test is one stat.

import type { Stat } from "../../fs/types.js";
import type { ByteStream } from "../exec/bytes.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  fail,
  result,
} from "../exec/context.js";
import { resolve } from "../exec/execute.js";
import { isFilesystemError } from "../exec/redirections.js";

/** A malformed or refused expression: status 2, as distinct from false. */
class TestError extends Error {}

const FILE_TESTS = new Set(["-e", "-f", "-d", "-s", "-L", "-h", "-r", "-w", "-x"]);
const STRING_TESTS = new Set(["-n", "-z"]);
const UNSUPPORTED_UNARY = new Set([
  "-a",
  "-b",
  "-c",
  "-g",
  "-G",
  "-k",
  "-N",
  "-O",
  "-p",
  "-S",
  "-t",
  "-u",
  "-v",
  "-R",
]);
const STRING_COMPARISONS = new Set(["=", "==", "!="]);
const INTEGER_COMPARISONS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const UNSUPPORTED_BINARY = new Set(["-nt", "-ot", "-ef", "<", ">"]);

export const test: Command = (context) => evaluate(context, context.argv);

export const bracket: Command = (context) => {
  const last = context.argv[context.argv.length - 1];
  if (last !== "]") return fail(context, "missing `]'", 2);
  return evaluate(context, context.argv.slice(0, -1));
};

function evaluate(context: CommandContext, args: readonly string[]): CommandResult {
  try {
    return result(nothing(), expression(context, args) ? 0 : 1);
  } catch (error) {
    if (error instanceof TestError) return fail(context, error.message, 2);
    throw error;
  }
}

function expression(context: CommandContext, args: readonly string[]): boolean {
  const [first = "", second = "", third = ""] = args;
  switch (args.length) {
    case 0:
      return false;
    case 1:
      return first !== "";
    case 2:
      if (first === "!") return second === "";
      return unary(context, first, second);
    case 3:
      if (isBinaryOperator(second)) return binary(first, second, third);
      if (first === "!") return !expression(context, args.slice(1));
      if (first === "(" && third === ")") return second !== "";
      throw new TestError(`${second}: binary operator expected`);
    case 4:
      if (first === "!") return !expression(context, args.slice(1));
      if (first === "(" && args[3] === ")") return expression(context, args.slice(1, 3));
      throw new TestError("this four-argument expression is not supported");
    default:
      if (first === "(" && args[args.length - 1] === ")") {
        return expression(context, args.slice(1, -1));
      }
      throw new TestError("expressions with more than four arguments are not supported");
  }
}

function unary(context: CommandContext, operator: string, operand: string): boolean {
  if (STRING_TESTS.has(operator)) return operator === "-n" ? operand !== "" : operand === "";
  if (FILE_TESTS.has(operator)) return fileTest(context, operator, operand);
  if (UNSUPPORTED_UNARY.has(operator)) throw new TestError(`${operator} is not supported`);
  throw new TestError(`${operator}: unary operator expected`);
}

function fileTest(context: CommandContext, operator: string, operand: string): boolean {
  if (operand === "") return false;
  const path = resolve(context.cwd, operand);
  const link = operator === "-L" || operator === "-h";
  const stat = statOrNull(() => (link ? context.fs.stat(path) : context.fs.statTarget(path)));
  if (stat === null) return false;
  switch (operator) {
    case "-f":
      return stat.type === "file";
    case "-d":
      return stat.type === "dir";
    case "-s":
      return stat.size > 0;
    case "-L":
    case "-h":
      return stat.type === "symlink";
    case "-r":
      return (stat.mode & 0o400) !== 0;
    case "-w":
      return (stat.mode & 0o200) !== 0;
    case "-x":
      return (stat.mode & 0o100) !== 0;
    default:
      return true;
  }
}

function statOrNull(read: () => Stat | null): Stat | null {
  try {
    return read();
  } catch (error) {
    // A path through a regular file is "not there" to test, as ENOTDIR is to Bash.
    if (isFilesystemError(error)) return null;
    throw error;
  }
}

function isBinaryOperator(value: string): boolean {
  return (
    STRING_COMPARISONS.has(value) ||
    INTEGER_COMPARISONS.has(value) ||
    UNSUPPORTED_BINARY.has(value) ||
    value === "-a" ||
    value === "-o"
  );
}

function binary(left: string, operator: string, right: string): boolean {
  if (operator === "=" || operator === "==") return left === right;
  if (operator === "!=") return left !== right;
  if (operator === "-a") return left !== "" && right !== "";
  if (operator === "-o") return left !== "" || right !== "";
  if (INTEGER_COMPARISONS.has(operator)) {
    const a = integer(left);
    const b = integer(right);
    switch (operator) {
      case "-eq":
        return a === b;
      case "-ne":
        return a !== b;
      case "-lt":
        return a < b;
      case "-le":
        return a <= b;
      case "-gt":
        return a > b;
      default:
        return a >= b;
    }
  }
  throw new TestError(`${operator} is not supported`);
}

function integer(value: string): bigint {
  const trimmed = value.trim();
  if (!/^[+-]?[0-9]+$/.test(trimmed)) throw new TestError(`${value}: integer expression expected`);
  return BigInt(trimmed);
}

function* nothing(): ByteStream {
  // A test answers with its status alone.
}
