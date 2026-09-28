// Synchronous expression evaluation, for expressions that call no user
// function. Expressions that do are evaluated by `steps.ts`, which can yield
// inside a function body. Left-associative chains (`a + b + …`, `a b c …`,
// `x || y || …`) evaluate iteratively down their left spine, so a long chain
// costs no stack.

import type { AwkArray, Entry, Subscript } from "./array.js";
import { callBuiltin, matchFunction, type Place, split, substitute } from "./builtins.js";
import { AwkRuntimeError } from "./errors.js";
import type { Splitter } from "./fields.js";
import type { CallArgument, Expr, LValue, Slot, Statement, VariableRef } from "./parse/ast.js";
import type { Regex } from "./regex/regex.js";
import type { Runtime } from "./runtime.js";
import { byteLength, compare, toNumber, toText, truthy, type Value } from "./values.js";

/** `exit` inside a function called from an expression unwinds to the rule. */
export class ExitSignal extends Error {
  constructor() {
    super("exit");
    this.name = "ExitSignal";
  }
}

export interface Frame {
  readonly values: Value[];
  readonly arrays: Array<AwkArray | null>;
  /** Arrays this frame created, whose bytes are released on return. */
  readonly owned: AwkArray[];
  returned: Value;
}

export type Flow = "normal" | "next" | "nextfile" | "exit" | "break" | "continue" | "return";

export type Step<T> = Generator<undefined, T, undefined>;

export type ChainLink = Extract<
  Expr,
  { readonly kind: "or" | "and" | "match" | "compare" | "concat" | "arithmetic" }
>;

export function isChainLink(expr: Expr): expr is ChainLink {
  switch (expr.kind) {
    case "or":
    case "and":
    case "match":
    case "compare":
    case "concat":
    case "arithmetic":
      return true;
    default:
      return false;
  }
}

/** The left operand of a chain link, which is evaluated first. */
export function leftOf(link: ChainLink): Expr {
  return link.kind === "match" ? link.subject : link.left;
}

/** A link's links down the left spine, outermost first, and the leftmost operand. */
export function spine(expr: ChainLink): { links: ChainLink[]; first: Expr } {
  const links: ChainLink[] = [];
  let node: Expr = expr;
  while (isChainLink(node)) {
    links.push(node);
    node = leftOf(node);
  }
  return { links, first: node };
}

export abstract class Evaluator {
  frame: Frame | null = null;

  constructor(readonly runtime: Runtime) {}

  abstract execute(statement: Statement): Step<Flow>;

  /** A user function call; synchronous evaluation drains it without yielding. */
  abstract call(name: string, args: readonly CallArgument[]): Step<Value>;

  evaluate(expr: Expr): Value {
    switch (expr.kind) {
      case "number":
      case "string":
        return expr.value;
      case "regex":
        return this.matchesRecord(expr.source);
      case "variable":
        return this.variable(expr.ref);
      case "element":
        return this.entry(this.array(expr.array), this.subscriptOf(expr.subscripts)).value;
      case "field":
        return this.runtime.fields.get(this.fieldIndex(this.evaluate(expr.index)));
      case "assign": {
        const place = this.locate(expr.target);
        return this.store(place, expr.op, this.evaluate(expr.value));
      }
      case "conditional":
        return truthy(this.evaluate(expr.test))
          ? this.evaluate(expr.then)
          : this.evaluate(expr.otherwise);
      case "or":
      case "and":
      case "match":
      case "compare":
      case "concat":
      case "arithmetic": {
        const { links, first } = spine(expr);
        let value = this.evaluate(first);
        for (let index = links.length - 1; index >= 0; index--) {
          const link = links[index];
          if (link !== undefined) value = this.link(link, value);
        }
        return value;
      }
      case "in":
        return this.contains(expr.array, this.subscriptOf(expr.subscripts));
      case "not":
        return truthy(this.evaluate(expr.operand)) ? 0 : 1;
      case "negate":
        return -toNumber(this.evaluate(expr.operand));
      case "plus":
        return toNumber(this.evaluate(expr.operand));
      case "increment":
        return this.increment(this.locate(expr.target), expr.delta, expr.prefix);
      case "call":
        return drain(this.call(expr.name, expr.args));
      case "builtin":
        return callBuiltin(
          this.runtime,
          expr.name,
          expr.args.map((arg) => this.evaluate(arg)),
        );
      case "arrayLength":
        return this.array(expr.array).size;
      case "lengthOfName":
        if (this.isArraySlot(expr.slot)) return this.array(expr.slot).size;
        return toText(this.variable(expr.slot), this.runtime).length;
      case "split": {
        const source = this.evaluate(expr.source);
        const separator = expr.separator;
        const splitter =
          separator === null || separator.kind === "regex"
            ? this.splitterOf(separator, null)
            : this.splitterOf(separator, this.evaluate(separator));
        return split(this.runtime, source, this.array(expr.array), splitter);
      }
      case "substitute": {
        const regex = this.regexOf(expr.pattern);
        const replacement = this.evaluate(expr.replacement);
        return substitute(this.runtime, expr.global, regex, replacement, this.locate(expr.target));
      }
      case "matchFunction": {
        const subject = this.evaluate(expr.subject);
        return matchFunction(this.runtime, subject, this.regexOf(expr.pattern));
      }
    }
  }

  /** Apply one chain link to its already evaluated left operand. */
  private link(link: ChainLink, left: Value): Value {
    switch (link.kind) {
      case "or":
        return truthy(left) || truthy(this.evaluate(link.right)) ? 1 : 0;
      case "and":
        return truthy(left) && truthy(this.evaluate(link.right)) ? 1 : 0;
      case "match":
        return this.matches(left, this.regexOf(link.pattern), link.negated);
      case "compare":
        return this.compare(link.op, left, this.evaluate(link.right)) ? 1 : 0;
      case "concat": {
        const text = toText(left, this.runtime);
        return text + toText(this.evaluate(link.right), this.runtime);
      }
      case "arithmetic":
        return arithmetic(link.op, toNumber(left), toNumber(this.evaluate(link.right)));
    }
  }

  matchesRecord(source: string): Value {
    const record = toText(this.runtime.fields.get(0), this.runtime);
    return this.runtime.regex(source).test(record) ? 1 : 0;
  }

  matches(subject: Value, regex: Regex, negated: boolean): Value {
    return regex.test(toText(subject, this.runtime)) !== negated ? 1 : 0;
  }

  compare(op: string, left: Value, right: Value): boolean {
    const order = compare(left, right, this.runtime);
    switch (op) {
      case "==":
        return order === 0;
      case "!=":
        return order !== 0;
      case "<":
        return order < 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      default:
        return order >= 0;
    }
  }

  /** The regex an operand denotes: a literal, or the text of any other value. */
  regexOf(expr: Expr): Regex {
    if (expr.kind === "regex") return this.runtime.regex(expr.source);
    return this.regexFrom(this.evaluate(expr));
  }

  regexFrom(value: Value): Regex {
    return this.runtime.regex(toText(value, this.runtime));
  }

  /** A `split` separator: FS when absent, a literal regex, or a value's text. */
  splitterOf(separator: Expr | null, value: Value): Splitter {
    if (separator === null) return this.runtime.splitter;
    if (separator.kind === "regex") {
      return { kind: "regex", regex: this.runtime.regex(separator.source) };
    }
    return this.runtime.splitterFor(value);
  }

  fieldIndex(value: Value): number {
    const number = toNumber(value);
    const index = Number.isNaN(number) ? 0 : Math.trunc(number);
    if (index < 0) throw new AwkRuntimeError(`negative field index $${index}`);
    return index;
  }

  variable(ref: VariableRef): Value {
    if (ref.scope === "special") return this.runtime.special(ref.name);
    if (ref.scope === "global") return this.runtime.globals[ref.index] ?? null;
    return this.frame?.values[ref.index] ?? null;
  }

  setVariable(ref: VariableRef, value: Value): void {
    if (ref.scope === "special") {
      this.runtime.setSpecial(ref.name, value);
      return;
    }
    const store = ref.scope === "global" ? this.runtime.globals : this.frame?.values;
    if (store === undefined) return;
    this.runtime.memory.adjust(byteLength(value) - byteLength(store[ref.index] ?? null));
    store[ref.index] = value;
  }

  isArraySlot(slot: Slot): boolean {
    if (slot.scope === "global") return this.runtime.arrays[slot.index] !== null;
    return (this.frame?.arrays[slot.index] ?? null) !== null;
  }

  array(slot: Slot): AwkArray {
    const array =
      slot.scope === "global" ? this.runtime.arrays[slot.index] : this.frame?.arrays[slot.index];
    if (array === undefined || array === null) {
      throw new AwkRuntimeError(`illegal reference to variable ${slot.name}`);
    }
    return array;
  }

  subscriptOf(subscripts: readonly Expr[]): Subscript {
    return this.subscriptFrom(subscripts.map((part) => this.evaluate(part)));
  }

  subscriptFrom(values: readonly Value[]): Subscript {
    const [only] = values;
    if (values.length === 1 && only !== undefined) return this.runtime.subscript(only);
    const separator = toText(this.runtime.special("SUBSEP"), this.runtime);
    return {
      kind: "string",
      value: values.map((part) => toText(part, this.runtime)).join(separator),
    };
  }

  contains(slot: Slot, subscript: Subscript): Value {
    return this.array(slot).find(subscript, false) === null ? 0 : 1;
  }

  /** The entry for a subscript, created (and charged) when absent, as a reference does. */
  entry(array: AwkArray, subscript: Subscript): Entry {
    const before = array.size;
    const entry = array.find(subscript, true);
    if (entry === null) throw new Error("awk: array lookup with create returned nothing");
    if (array.size > before) {
      this.runtime.created(array, subscript.kind === "string" ? subscript.value.length : 8);
    }
    return entry;
  }

  /** An lvalue with its subscripts or field index evaluated once. */
  locate(target: LValue): Place {
    switch (target.kind) {
      case "variable":
        return this.variablePlace(target.ref);
      case "element":
        return this.elementPlace(target.array, this.subscriptOf(target.subscripts));
      case "field":
        return this.fieldPlace(this.fieldIndex(this.evaluate(target.index)));
    }
  }

  variablePlace(ref: VariableRef): Place {
    return { get: () => this.variable(ref), set: (value) => this.setVariable(ref, value) };
  }

  elementPlace(slot: Slot, subscript: Subscript): Place {
    const array = this.array(slot);
    const entry = this.entry(array, subscript);
    return {
      get: () => entry.value,
      set: (value) => this.runtime.setElement(array, entry, value),
    };
  }

  fieldPlace(index: number): Place {
    const fields = this.runtime.fields;
    return { get: () => fields.get(index), set: (value) => fields.set(index, value) };
  }

  store(place: Place, op: string, value: Value): Value {
    if (op === "=") {
      place.set(value);
      return value;
    }
    const result = arithmetic(op.charAt(0), toNumber(place.get()), toNumber(value));
    place.set(result);
    return result;
  }

  increment(place: Place, delta: number, prefix: boolean): Value {
    const old = toNumber(place.get());
    const next = old + delta;
    place.set(next);
    return prefix ? next : old;
  }
}

/** Run a step to completion without yielding. */
export function drain<T>(step: Step<T>): T {
  for (;;) {
    const next = step.next();
    if (next.done === true) return next.value;
  }
}

export function arithmetic(op: string, left: number, right: number): number {
  switch (op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    case "%":
      return left % right;
    default:
      return left ** right;
  }
}
