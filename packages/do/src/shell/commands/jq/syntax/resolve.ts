// Name resolution before a program runs, as jq's binder does: an unknown
// function or variable is a compile error with jq's located message. It is
// also where the bounded-execution refusals are decided statically: a jq
// builtin this shell declines, a recursive `def`, and `recurse(f)` whose f is
// not a chain of index and iterate steps.

import { JqRefusal } from "../errors.js";
import { isNumber } from "../value.js";
import type { Definition, Node, Pattern, Span } from "./ast.js";
import { compileError, locate } from "./parser.js";

export interface Names {
  readonly functions: ReadonlySet<string>;
  readonly refused: ReadonlySet<string>;
  readonly variables: ReadonlySet<string>;
}

interface Scope {
  readonly variables: ReadonlySet<string>;
  readonly functions: ReadonlyMap<string, Definition | null>;
  readonly labels: ReadonlySet<string>;
}

/** Resolves `program` and returns the global functions it calls directly. */
export function resolve(program: Node, source: string, names: Names): ReadonlySet<string> {
  const resolver = new Resolver(source, names);
  resolver.visit(program, {
    variables: names.variables,
    functions: new Map(),
    labels: new Set(),
  });
  if (resolver.diagnostics.length > 0) throw compileError(resolver.diagnostics);
  return resolver.globals;
}

class Resolver {
  readonly diagnostics: string[] = [];
  readonly globals = new Set<string>();
  readonly #defining = new Set<Definition>();

  constructor(
    private readonly source: string,
    private readonly names: Names,
  ) {}

  #error(span: Span, message: string): void {
    this.diagnostics.push(locate(this.source, span, message));
  }

  visit(node: Node, scope: Scope): void {
    switch (node.kind) {
      case "identity":
      case "literal":
      case "format":
        return;
      case "index":
        this.visit(node.target, scope);
        this.visit(node.key, scope);
        return;
      case "slice":
        this.visit(node.target, scope);
        if (node.from !== null) this.visit(node.from, scope);
        if (node.to !== null) this.visit(node.to, scope);
        return;
      case "iterate":
        this.visit(node.target, scope);
        return;
      case "string":
        for (const part of node.parts) if (typeof part !== "string") this.visit(part, scope);
        return;
      case "array":
        if (node.body !== null) this.visit(node.body, scope);
        return;
      case "object":
        for (const entry of node.entries) {
          this.visit(entry.key, scope);
          this.visit(entry.value, scope);
        }
        return;
      case "negate":
        this.visit(node.body, scope);
        return;
      case "pipe":
      case "comma":
      case "binary":
      case "and":
      case "or":
      case "alternative":
      case "assign":
        this.visit(node.left, scope);
        this.visit(node.right, scope);
        return;
      case "if":
        this.visit(node.condition, scope);
        this.visit(node.then, scope);
        if (node.otherwise !== null) this.visit(node.otherwise, scope);
        return;
      case "try":
        this.visit(node.body, scope);
        if (node.handler !== null) this.visit(node.handler, scope);
        return;
      case "reduce":
      case "foreach": {
        this.visit(node.source, scope);
        this.visit(node.init, scope);
        const inner = this.#pattern(node.pattern, scope);
        this.visit(node.update, inner);
        if (node.kind === "foreach" && node.extract !== null) this.visit(node.extract, inner);
        return;
      }
      case "bind":
        this.visit(node.source, scope);
        this.visit(node.body, this.#pattern(node.pattern, scope));
        return;
      case "variable":
        if (!scope.variables.has(node.name)) this.#error(node, `$${node.name} is not defined`);
        return;
      case "call":
        this.#call(node, scope);
        return;
      case "define":
        this.#define(node.definition, scope);
        this.visit(node.body, withFunction(scope, node.definition, node.definition));
        return;
      case "label":
        this.visit(node.body, { ...scope, labels: new Set([...scope.labels, node.name]) });
        return;
      case "break":
        if (!scope.labels.has(node.name)) this.#error(node, `$*label-${node.name} is not defined`);
        return;
    }
  }

  #call(node: Extract<Node, { kind: "call" }>, scope: Scope): void {
    const key = `${node.name}/${node.args.length}`;
    if (scope.functions.has(key)) {
      const definition = scope.functions.get(key);
      if (definition !== undefined && definition !== null && this.#defining.has(definition)) {
        throw new JqRefusal(`recursive function ${key} is not supported`);
      }
    } else if (this.names.refused.has(key)) {
      throw new JqRefusal(`${key} is not supported`);
    } else if (!this.names.functions.has(key)) {
      this.#error(node, `${key} is not defined`);
    } else if ((key === "recurse/1" || key === "recurse/2") && !isStep(node.args[0])) {
      throw new JqRefusal(
        "recurse(f) is supported only when f is a chain of .key, .[n], and .[] steps",
      );
    } else {
      this.globals.add(key);
    }
    for (const arg of node.args) this.visit(arg, scope);
  }

  #define(definition: Definition, scope: Scope): void {
    let inner = withFunction(scope, definition, definition);
    for (const param of definition.params) {
      inner = withFunction(inner, { name: param.name, params: [] }, null);
      if (param.value) inner = { ...inner, variables: new Set([...inner.variables, param.name]) };
    }
    this.#defining.add(definition);
    this.visit(definition.body, inner);
    this.#defining.delete(definition);
  }

  #pattern(pattern: Pattern, scope: Scope): Scope {
    const variables = new Set(scope.variables);
    const collect = (current: Pattern): void => {
      if (current.kind === "variable") variables.add(current.name);
      else if (current.kind === "array") current.items.forEach(collect);
      else {
        for (const entry of current.entries) {
          this.visit(entry.key, scope);
          if (entry.binding !== null) variables.add(entry.binding.name);
          if (entry.pattern !== null) collect(entry.pattern);
        }
      }
    };
    collect(pattern);
    return { ...scope, variables };
  }
}

function withFunction(
  scope: Scope,
  definition: { readonly name: string; readonly params: readonly unknown[] },
  entry: Definition | null,
): Scope {
  const functions = new Map(scope.functions);
  functions.set(`${definition.name}/${definition.params.length}`, entry);
  return { ...scope, functions };
}

/** A path made only of steps that descend into the value: `.a`, `.[0]`, `.[]`, `?`. */
function isStep(node: Node | undefined): boolean {
  if (node === undefined) return false;
  switch (node.kind) {
    case "index":
      return (
        node.key.kind === "literal" &&
        (typeof node.key.value === "string" || isNumber(node.key.value)) &&
        stepOrIdentity(node.target)
      );
    case "iterate":
      return stepOrIdentity(node.target);
    case "pipe":
      return (
        stepOrIdentity(node.left) &&
        stepOrIdentity(node.right) &&
        (isStep(node.left) || isStep(node.right))
      );
    case "comma":
      return isStep(node.left) && isStep(node.right);
    case "try":
      return node.handler === null && isStep(node.body);
    default:
      return false;
  }
}

function stepOrIdentity(node: Node): boolean {
  return node.kind === "identity" || isStep(node);
}
