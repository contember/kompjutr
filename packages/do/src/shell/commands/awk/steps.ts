// Evaluation that can pause inside user functions. An expression that calls a
// function is evaluated as a generator, and the function body runs as
// statements do, yielding after output; so a consumer that stops reading
// (`awk … | head -1`) stops even a program whose calls fan out. Subtrees that
// call nothing still go through the synchronous evaluator.

import type { Place } from "./builtins.js";
import { callBuiltin, matchFunction, split, substitute } from "./builtins.js";
import { AwkRuntimeError } from "./errors.js";
import {
  arithmetic,
  type ChainLink,
  Evaluator,
  ExitSignal,
  type Flow,
  type Frame,
  type Step,
  spine,
} from "./evaluate.js";
import type { CallArgument, Expr, LValue } from "./parse/ast.js";
import type { Regex } from "./regex/regex.js";
import { byteLength, toNumber, toText, truthy, type Value } from "./values.js";

/** The expressions directly under an expression, and whether it is itself a call. */
function children(expr: Expr): readonly Expr[] {
  switch (expr.kind) {
    case "number":
    case "string":
    case "regex":
    case "variable":
    case "arrayLength":
    case "lengthOfName":
    case "call":
      return [];
    case "element":
    case "in":
      return expr.subscripts;
    case "field":
      return [expr.index];
    case "assign":
      return [...lvalueChildren(expr.target), expr.value];
    case "conditional":
      return [expr.test, expr.then, expr.otherwise];
    case "or":
    case "and":
    case "compare":
    case "concat":
    case "arithmetic":
      return [expr.left, expr.right];
    case "match":
    case "matchFunction":
      return [expr.subject, expr.pattern];
    case "not":
    case "negate":
    case "plus":
      return [expr.operand];
    case "increment":
      return lvalueChildren(expr.target);
    case "builtin":
      return expr.args;
    case "split":
      return expr.separator === null ? [expr.source] : [expr.source, expr.separator];
    case "substitute":
      return [expr.pattern, expr.replacement, ...lvalueChildren(expr.target)];
  }
}

function lvalueChildren(target: LValue): readonly Expr[] {
  if (target.kind === "variable") return [];
  if (target.kind === "field") return [target.index];
  return target.subscripts;
}

export abstract class SteppingEvaluator extends Evaluator {
  /** Whether each analysed expression calls no user function anywhere below it. */
  readonly #callFree = new WeakMap<Expr, boolean>();

  /** Iterative, so a long chain cannot exhaust the stack. */
  callFree(root: Expr): boolean {
    const known = this.#callFree.get(root);
    if (known !== undefined) return known;
    const stack: Array<{ expr: Expr; expanded: boolean }> = [{ expr: root, expanded: false }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top === undefined) break;
      if (this.#callFree.has(top.expr)) {
        stack.pop();
        continue;
      }
      const below = children(top.expr);
      if (!top.expanded) {
        top.expanded = true;
        for (const child of below) {
          if (!this.#callFree.has(child)) stack.push({ expr: child, expanded: false });
        }
        continue;
      }
      stack.pop();
      const free =
        top.expr.kind !== "call" && below.every((child) => this.#callFree.get(child) === true);
      this.#callFree.set(top.expr, free);
    }
    return this.#callFree.get(root) === true;
  }

  *steps(expr: Expr): Step<Value> {
    if (this.callFree(expr)) return this.evaluate(expr);
    switch (expr.kind) {
      case "element": {
        const subscript = this.subscriptFrom(yield* this.all(expr.subscripts));
        return this.entry(this.array(expr.array), subscript).value;
      }
      case "field":
        return this.runtime.fields.get(this.fieldIndex(yield* this.steps(expr.index)));
      case "assign": {
        const place = yield* this.locateSteps(expr.target);
        return this.store(place, expr.op, yield* this.steps(expr.value));
      }
      case "conditional":
        return truthy(yield* this.steps(expr.test))
          ? yield* this.steps(expr.then)
          : yield* this.steps(expr.otherwise);
      case "or":
      case "and":
      case "match":
      case "compare":
      case "concat":
      case "arithmetic": {
        const { links, first } = spine(expr);
        let value = yield* this.steps(first);
        for (let index = links.length - 1; index >= 0; index--) {
          const link = links[index];
          if (link !== undefined) value = yield* this.linkSteps(link, value);
        }
        return value;
      }
      case "in":
        return this.contains(expr.array, this.subscriptFrom(yield* this.all(expr.subscripts)));
      case "not":
        return truthy(yield* this.steps(expr.operand)) ? 0 : 1;
      case "negate":
        return -toNumber(yield* this.steps(expr.operand));
      case "plus":
        return toNumber(yield* this.steps(expr.operand));
      case "increment":
        return this.increment(yield* this.locateSteps(expr.target), expr.delta, expr.prefix);
      case "call":
        return yield* this.call(expr.name, expr.args);
      case "builtin":
        return callBuiltin(this.runtime, expr.name, yield* this.all(expr.args));
      case "split": {
        const source = yield* this.steps(expr.source);
        const separator = expr.separator;
        const value =
          separator === null || separator.kind === "regex" ? null : yield* this.steps(separator);
        return split(
          this.runtime,
          source,
          this.array(expr.array),
          this.splitterOf(separator, value),
        );
      }
      case "substitute": {
        const regex = yield* this.regexSteps(expr.pattern);
        const replacement = yield* this.steps(expr.replacement);
        const place = yield* this.locateSteps(expr.target);
        return substitute(this.runtime, expr.global, regex, replacement, place);
      }
      case "matchFunction": {
        const subject = yield* this.steps(expr.subject);
        return matchFunction(this.runtime, subject, yield* this.regexSteps(expr.pattern));
      }
      default:
        return this.evaluate(expr);
    }
  }

  private *linkSteps(link: ChainLink, left: Value): Step<Value> {
    switch (link.kind) {
      case "or":
        return truthy(left) || truthy(yield* this.steps(link.right)) ? 1 : 0;
      case "and":
        return truthy(left) && truthy(yield* this.steps(link.right)) ? 1 : 0;
      case "match":
        return this.matches(left, yield* this.regexSteps(link.pattern), link.negated);
      case "compare":
        return this.compare(link.op, left, yield* this.steps(link.right)) ? 1 : 0;
      case "concat": {
        const text = toText(left, this.runtime);
        return text + toText(yield* this.steps(link.right), this.runtime);
      }
      case "arithmetic":
        return arithmetic(link.op, toNumber(left), toNumber(yield* this.steps(link.right)));
    }
  }

  *all(exprs: readonly Expr[]): Step<Value[]> {
    const values: Value[] = [];
    for (const expr of exprs) values.push(yield* this.steps(expr));
    return values;
  }

  private *regexSteps(expr: Expr): Step<Regex> {
    if (expr.kind === "regex") return this.runtime.regex(expr.source);
    return this.regexFrom(yield* this.steps(expr));
  }

  private *locateSteps(target: LValue): Step<Place> {
    switch (target.kind) {
      case "variable":
        return this.variablePlace(target.ref);
      case "element":
        return this.elementPlace(
          target.array,
          this.subscriptFrom(yield* this.all(target.subscripts)),
        );
      case "field":
        return this.fieldPlace(this.fieldIndex(yield* this.steps(target.index)));
    }
  }

  *call(name: string, args: readonly CallArgument[]): Step<Value> {
    const definition = this.runtime.program.functions.get(name);
    if (definition === undefined) throw new AwkRuntimeError(`function ${name} never defined`);
    const frame: Frame = { values: [], arrays: [], owned: [], returned: null };
    for (let index = 0; index < definition.params.length; index++) {
      const arg = args[index];
      if (definition.arrays[index] === true) {
        if (arg?.kind === "name") frame.arrays.push(this.array(arg.slot));
        else {
          const fresh = this.runtime.newArray();
          frame.owned.push(fresh);
          frame.arrays.push(fresh);
        }
        frame.values.push(null);
        continue;
      }
      let value: Value = null;
      if (arg?.kind === "expr") value = yield* this.steps(arg.expr);
      else if (arg?.kind === "name" && !this.isArraySlot(arg.slot)) value = this.variable(arg.slot);
      this.runtime.memory.adjust(byteLength(value));
      frame.values.push(value);
      frame.arrays.push(null);
    }
    const saved = this.frame;
    this.frame = frame;
    let flow: Flow;
    try {
      flow = yield* this.execute(definition.body);
    } finally {
      this.frame = saved;
      for (const value of frame.values) this.runtime.memory.adjust(-byteLength(value));
      for (const array of frame.owned) this.runtime.clearArray(array);
    }
    if (flow === "exit") throw new ExitSignal();
    return frame.returned;
  }
}
