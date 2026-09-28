// Expression evaluation. Statements and the main loop are in `interpreter.ts`.

import type { AwkArray, Entry, Subscript } from "./array.js";
import { callBuiltin, matchFunction, split, substitute } from "./builtins.js";
import { AwkRuntimeError } from "./errors.js";
import type {
  CallArgument,
  Expr,
  FunctionDefinition,
  LValue,
  Slot,
  Statement,
  VariableRef,
} from "./parse/ast.js";
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

export abstract class Evaluator {
  frame: Frame | null = null;

  constructor(readonly runtime: Runtime) {}

  /** Run a function body to completion; output lands in the runtime's buffer. */
  abstract runBody(body: Statement): Flow;

  evaluate(expr: Expr): Value {
    switch (expr.kind) {
      case "number":
      case "string":
        return expr.value;
      case "regex":
        return this.regexOf(expr).test(toText(this.runtime.fields.get(0), this.runtime)) ? 1 : 0;
      case "variable":
        return this.variable(expr.ref);
      case "element": {
        const array = this.array(expr.array);
        return this.entry(array, this.subscriptOf(expr.subscripts)).value;
      }
      case "field":
        return this.runtime.fields.get(this.fieldIndex(expr.index));
      case "assign":
        return this.assign(expr.target, expr.op, expr.value);
      case "conditional":
        return truthy(this.evaluate(expr.test))
          ? this.evaluate(expr.then)
          : this.evaluate(expr.otherwise);
      case "or":
        return truthy(this.evaluate(expr.left)) || truthy(this.evaluate(expr.right)) ? 1 : 0;
      case "and":
        return truthy(this.evaluate(expr.left)) && truthy(this.evaluate(expr.right)) ? 1 : 0;
      case "in": {
        const subscript = this.subscriptOf(expr.subscripts);
        return this.array(expr.array).find(subscript, false) === null ? 0 : 1;
      }
      case "match": {
        const subject = toText(this.evaluate(expr.subject), this.runtime);
        const matched = this.regexOf(expr.pattern).test(subject);
        return matched !== expr.negated ? 1 : 0;
      }
      case "compare":
        return this.compare(expr.op, this.evaluate(expr.left), this.evaluate(expr.right)) ? 1 : 0;
      case "concat": {
        const left = toText(this.evaluate(expr.left), this.runtime);
        return left + toText(this.evaluate(expr.right), this.runtime);
      }
      case "arithmetic":
        return arithmetic(
          expr.op,
          toNumber(this.evaluate(expr.left)),
          toNumber(this.evaluate(expr.right)),
        );
      case "not":
        return truthy(this.evaluate(expr.operand)) ? 0 : 1;
      case "negate":
        return -toNumber(this.evaluate(expr.operand));
      case "plus":
        return toNumber(this.evaluate(expr.operand));
      case "increment": {
        const target = this.locate(expr.target);
        const old = toNumber(target.get());
        const next = old + expr.delta;
        target.set(next);
        return expr.prefix ? next : old;
      }
      case "call":
        return this.call(expr.name, expr.args);
      case "builtin":
        return callBuiltin(this, expr.name, expr.args);
      case "arrayLength":
        return this.array(expr.array).size;
      case "lengthOfName":
        if (this.isArraySlot(expr.slot)) return this.array(expr.slot).size;
        return toText(this.variable(expr.slot), this.runtime).length;
      case "split":
        return split(this, expr.source, expr.array, expr.separator);
      case "substitute":
        return substitute(this, expr.global, expr.pattern, expr.replacement, expr.target);
      case "matchFunction":
        return matchFunction(this, expr.subject, expr.pattern);
    }
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
    return this.runtime.regex(toText(this.evaluate(expr), this.runtime));
  }

  fieldIndex(expr: Expr): number {
    const number = toNumber(this.evaluate(expr));
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
    if (slot.scope === "global") {
      const array = this.runtime.arrays[slot.index];
      if (array === undefined || array === null) {
        throw new AwkRuntimeError(`illegal reference to variable ${slot.name}`);
      }
      return array;
    }
    const frame = this.frame;
    const array = frame?.arrays[slot.index];
    if (frame === null || array === undefined || array === null) {
      throw new AwkRuntimeError(`illegal reference to variable ${slot.name}`);
    }
    return array;
  }

  subscriptOf(subscripts: readonly Expr[]): Subscript {
    const [only] = subscripts;
    if (subscripts.length === 1 && only !== undefined)
      return this.runtime.subscript(this.evaluate(only));
    const separator = toText(this.runtime.special("SUBSEP"), this.runtime);
    const parts = subscripts.map((part) => toText(this.evaluate(part), this.runtime));
    return { kind: "string", value: parts.join(separator) };
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

  /** An lvalue's current value and a setter, with its subscripts evaluated once. */
  locate(target: LValue): { get(): Value; set(value: Value): void } {
    switch (target.kind) {
      case "variable":
        return {
          get: () => this.variable(target.ref),
          set: (value) => this.setVariable(target.ref, value),
        };
      case "element": {
        const array = this.array(target.array);
        const entry = this.entry(array, this.subscriptOf(target.subscripts));
        return {
          get: () => entry.value,
          set: (value) => this.runtime.setElement(array, entry, value),
        };
      }
      case "field": {
        const index = this.fieldIndex(target.index);
        const fields = this.runtime.fields;
        return {
          get: () => fields.get(index),
          set: (value) => {
            const before = fields.bytes;
            fields.set(index, value);
            this.runtime.memory.adjust(fields.bytes - before);
          },
        };
      }
    }
  }

  private assign(target: LValue, op: string, valueExpr: Expr): Value {
    const place = this.locate(target);
    const value = this.evaluate(valueExpr);
    if (op === "=") {
      place.set(value);
      return value;
    }
    const result = arithmetic(op.charAt(0), toNumber(place.get()), toNumber(value));
    place.set(result);
    return result;
  }

  private call(name: string, args: readonly CallArgument[]): Value {
    const definition = this.runtime.program.functions.get(name);
    if (definition === undefined) throw new AwkRuntimeError(`function ${name} never defined`);
    const frame = this.frameFor(definition, args);
    const saved = this.frame;
    this.frame = frame;
    let flow: Flow;
    try {
      flow = this.runBody(definition.body);
    } finally {
      this.frame = saved;
      this.releaseFrame(frame);
    }
    if (flow === "exit") throw new ExitSignal();
    return frame.returned;
  }

  private frameFor(definition: FunctionDefinition, args: readonly CallArgument[]): Frame {
    const frame: Frame = { values: [], arrays: [], owned: [], returned: null };
    definition.params.forEach((_, index) => {
      const arg = args[index];
      if (definition.arrays[index] === true) {
        if (arg?.kind === "name") frame.arrays.push(this.array(arg.slot));
        else {
          const fresh = this.runtime.newArray();
          frame.owned.push(fresh);
          frame.arrays.push(fresh);
        }
        frame.values.push(null);
        return;
      }
      let value: Value = null;
      if (arg?.kind === "expr") value = this.evaluate(arg.expr);
      else if (arg?.kind === "name" && !this.isArraySlot(arg.slot)) value = this.variable(arg.slot);
      this.runtime.memory.adjust(byteLength(value));
      frame.values.push(value);
      frame.arrays.push(null);
    });
    return frame;
  }

  private releaseFrame(frame: Frame): void {
    for (const value of frame.values) this.runtime.memory.adjust(-byteLength(value));
    for (const array of frame.owned) this.runtime.clearArray(array);
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
