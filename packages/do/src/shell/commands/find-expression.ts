// find's argument language: starting points, then an expression of tests,
// actions, and operators with GNU precedence — `!` over implicit or explicit
// `-a` over `-o`, with parentheses. Global options (`-maxdepth`, `-mindepth`)
// may appear anywhere and evaluate as true. Predicates whose cost or meaning
// has no counterpart here are refused by name.

import type { EntryType } from "../../fs/types.js";
import { compileFnmatch } from "../exec/glob.js";
import { UsageError } from "./flags.js";

export type Expression =
  | { readonly kind: "and" | "or"; readonly left: Expression; readonly right: Expression }
  | { readonly kind: "not"; readonly operand: Expression }
  | {
      readonly kind: "name" | "path";
      readonly pattern: string;
      readonly ignoreCase: boolean;
      test(value: string): boolean;
    }
  | { readonly kind: "type"; readonly types: ReadonlySet<EntryType> }
  | { readonly kind: "constant"; readonly value: boolean }
  | { readonly kind: "print"; readonly terminator: string }
  | { readonly kind: "prune" };

export interface FindCommand {
  readonly startingPoints: readonly string[];
  readonly expression: Expression;
  readonly maxDepth: number | null;
  readonly minDepth: number;
}

/** A GNU diagnostic: find exits 1 on a malformed expression. */
export class FindUsageError extends Error {}

const TYPES: ReadonlyMap<string, EntryType> = new Map([
  ["f", "file"],
  ["d", "dir"],
  ["l", "symlink"],
]);

const UNSUPPORTED = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-size",
  "-empty",
  "-newer",
  "-mtime",
  "-mmin",
  "-atime",
  "-amin",
  "-ctime",
  "-cmin",
  "-perm",
  "-regex",
  "-iregex",
  "-user",
  "-group",
  "-links",
  "-inum",
  "-samefile",
  "-printf",
  "-fprint",
  "-ls",
  "-follow",
  "-xdev",
  "-mount",
  "-depth",
  "-L",
  "-H",
  "-P",
]);

export function parseFind(argv: readonly string[]): FindCommand {
  let index = 0;
  const startingPoints: string[] = [];
  while (index < argv.length && !startsExpression(argv[index] ?? "")) {
    startingPoints.push(argv[index] ?? "");
    index++;
  }

  const parser = new ExpressionParser(argv.slice(index));
  const parsed = parser.parse();
  const expression: Expression =
    parsed === null
      ? { kind: "print", terminator: "\n" }
      : hasAction(parsed)
        ? parsed
        : { kind: "and", left: parsed, right: { kind: "print", terminator: "\n" } };
  return {
    startingPoints: startingPoints.length === 0 ? ["."] : startingPoints,
    expression,
    maxDepth: parser.maxDepth,
    minDepth: parser.minDepth,
  };
}

function startsExpression(arg: string): boolean {
  return (arg.startsWith("-") && arg !== "-") || arg === "!" || arg === "(" || arg === ")";
}

function hasAction(expression: Expression): boolean {
  switch (expression.kind) {
    case "and":
    case "or":
      return hasAction(expression.left) || hasAction(expression.right);
    case "not":
      return hasAction(expression.operand);
    case "print":
      return true;
    default:
      return false;
  }
}

class ExpressionParser {
  #index = 0;
  maxDepth: number | null = null;
  minDepth = 0;

  constructor(private readonly args: readonly string[]) {}

  parse(): Expression | null {
    if (this.args.length === 0) return null;
    const expression = this.#or();
    const next = this.args[this.#index];
    if (next === ")") {
      throw new FindUsageError("you have too many ')'");
    }
    if (next !== undefined) throw new FindUsageError(`paths must precede expression: \`${next}'`);
    return expression;
  }

  #or(): Expression {
    let left = this.#and();
    while (this.#peek("-o") || this.#peek("-or")) {
      const operator = this.args[this.#index] ?? "";
      this.#index++;
      if (this.#atEnd()) {
        throw new FindUsageError(`expected an expression after '${operator}'`);
      }
      left = { kind: "or", left, right: this.#and() };
    }
    return left;
  }

  #and(): Expression {
    let left = this.#unary();
    for (;;) {
      if (this.#peek("-a") || this.#peek("-and")) {
        this.#index++;
      } else if (this.#atEnd() || this.#peek("-o") || this.#peek("-or") || this.#peek(")")) {
        return left;
      }
      left = { kind: "and", left, right: this.#unary() };
    }
  }

  #unary(): Expression {
    const arg = this.args[this.#index];
    if (arg === undefined) {
      throw new FindUsageError("invalid expression; expected an expression");
    }
    if (arg === "!" || arg === "-not") {
      this.#index++;
      return { kind: "not", operand: this.#unary() };
    }
    if (arg === "(") {
      this.#index++;
      const inner = this.#or();
      if (!this.#peek(")")) {
        throw new FindUsageError(
          "invalid expression; I was expecting to find a ')' somewhere but did not see one.",
        );
      }
      this.#index++;
      return inner;
    }
    if (arg === "-o" || arg === "-or" || arg === "-a" || arg === "-and") {
      throw new FindUsageError(
        `invalid expression; you have used a binary operator '${arg}' with nothing before it.`,
      );
    }
    this.#index++;
    return this.#primary(arg);
  }

  #primary(name: string): Expression {
    switch (name) {
      case "-name":
      case "-iname":
        return this.#pattern("name", name === "-iname", this.#value(name));
      case "-path":
      case "-ipath":
      case "-wholename":
      case "-iwholename":
        return this.#pattern("path", name.startsWith("-i"), this.#value(name));
      case "-type":
        return { kind: "type", types: this.#types(this.#value(name)) };
      case "-maxdepth":
        this.maxDepth = this.#depth(name);
        return { kind: "constant", value: true };
      case "-mindepth":
        this.minDepth = this.#depth(name);
        return { kind: "constant", value: true };
      case "-true":
      case "-false":
        return { kind: "constant", value: name === "-true" };
      case "-print":
      case "-print0":
        return { kind: "print", terminator: name === "-print0" ? "\0" : "\n" };
      case "-prune":
        return { kind: "prune" };
      default:
        if (UNSUPPORTED.has(name)) {
          throw new UsageError(
            `${name} is not supported; supported: -name, -iname, -path, -ipath, -type, ` +
              "-maxdepth, -mindepth, -prune, -print, -print0, -true, -false, !, -a, -o, ( )",
          );
        }
        if (!name.startsWith("-")) {
          throw new FindUsageError(`paths must precede expression: \`${name}'`);
        }
        throw new FindUsageError(`unknown predicate \`${name}'`);
    }
  }

  #pattern(kind: "name" | "path", ignoreCase: boolean, pattern: string): Expression {
    return { kind, pattern, ignoreCase, test: compileFnmatch(pattern, ignoreCase).test };
  }

  #value(name: string): string {
    const value = this.args[this.#index];
    if (value === undefined) throw new FindUsageError(`missing argument to \`${name}'`);
    this.#index++;
    return value;
  }

  #types(value: string): ReadonlySet<EntryType> {
    const types = new Set<EntryType>();
    for (const letter of value.split(",")) {
      const type = TYPES.get(letter);
      if (type === undefined) throw new FindUsageError(`Unknown argument to -type: ${letter}`);
      types.add(type);
    }
    return types;
  }

  #depth(name: string): number {
    const value = this.#value(name);
    if (!/^[0-9]+$/.test(value)) {
      throw new FindUsageError(
        `Expected a positive decimal integer argument to ${name}, but got '${value}'`,
      );
    }
    return Number(value);
  }

  #peek(value: string): boolean {
    return this.args[this.#index] === value;
  }

  #atEnd(): boolean {
    return this.#index >= this.args.length;
  }
}
