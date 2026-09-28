// Statement execution. Each statement is a generator that yields after it
// writes output, so the driver can flush between statements and a consumer
// that stops reading (`awk … | head`) stops the program — inside function
// bodies too, since calls run through `steps.ts`.

import { formatted } from "./builtins.js";
import type { Flow, Step } from "./evaluate.js";
import type { Expr, Rule, Statement } from "./parse/ast.js";
import { ELEMENT_OVERHEAD, type Runtime } from "./runtime.js";
import { SteppingEvaluator } from "./steps.js";
import { byteLength, toNumber, toOutputText, toText, truthy, type Value } from "./values.js";

export class Interpreter extends SteppingEvaluator {
  exitStatus = 0;
  readonly #ranges: boolean[];

  constructor(runtime: Runtime) {
    super(runtime);
    this.#ranges = runtime.program.rules.map(() => false);
  }

  /** An expression's value; only one that calls a function pays for a generator. */
  private *value(expr: Expr): Step<Value> {
    return this.callFree(expr) ? this.evaluate(expr) : yield* this.steps(expr);
  }

  private *values(exprs: readonly Expr[]): Step<Value[]> {
    const values: Value[] = [];
    for (const expr of exprs) {
      values.push(this.callFree(expr) ? this.evaluate(expr) : yield* this.steps(expr));
    }
    return values;
  }

  *execute(statement: Statement): Step<Flow> {
    switch (statement.kind) {
      case "expr":
        if (this.callFree(statement.expr)) this.evaluate(statement.expr);
        else yield* this.steps(statement.expr);
        return "normal";
      case "print":
        this.print(yield* this.values(statement.args));
        yield;
        return "normal";
      case "printf":
        this.runtime.output.write(
          formatted(this.runtime, "printf", yield* this.values(statement.args)),
        );
        yield;
        return "normal";
      case "if":
        for (const branch of statement.branches) {
          if (truthy(yield* this.value(branch.test))) return yield* this.execute(branch.body);
        }
        return statement.otherwise === null ? "normal" : yield* this.execute(statement.otherwise);
      case "block":
        for (const inner of statement.body) {
          const flow = yield* this.execute(inner);
          if (flow !== "normal") return flow;
        }
        return "normal";
      case "forIn": {
        const keys = this.array(statement.array).keys();
        for (const key of keys) {
          this.setVariable(statement.variable, key);
          const flow = yield* this.execute(statement.body);
          if (flow === "break") break;
          if (flow !== "normal" && flow !== "continue") return flow;
          yield;
        }
        return "normal";
      }
      case "next":
      case "nextfile":
      case "break":
      case "continue":
        return statement.kind;
      case "empty":
        return "normal";
      case "exit":
        if (statement.value !== null) {
          this.exitStatus = exitCode(toNumber(yield* this.value(statement.value)));
        }
        return "exit";
      case "return": {
        const value = statement.value === null ? null : yield* this.value(statement.value);
        if (this.frame !== null) this.frame.returned = value;
        return "return";
      }
      case "delete":
        yield* this.delete(statement);
        return "normal";
    }
  }

  private *delete(statement: Extract<Statement, { kind: "delete" }>): Step<void> {
    const array = this.array(statement.array);
    if (statement.subscripts === null) {
      this.runtime.clearArray(array);
      return;
    }
    const subscript = this.subscriptFrom(yield* this.values(statement.subscripts));
    const entry = array.find(subscript, false);
    if (entry === null) return;
    const keyBytes = subscript.kind === "string" ? subscript.value.length : 8;
    this.runtime.charge(array, -(keyBytes + ELEMENT_OVERHEAD + byteLength(entry.value)));
    array.delete(subscript);
  }

  print(values: readonly Value[]): void {
    const runtime = this.runtime;
    const items = values.length === 0 ? [runtime.fields.get(0)] : values;
    const separator = toText(runtime.special("OFS"), runtime);
    const text = items.map((value) => toOutputText(value, runtime)).join(separator);
    runtime.output.write(`${text}${toText(runtime.special("ORS"), runtime)}`);
  }

  /** The main rules against the current record. */
  *rules(): Step<Flow> {
    const rules = this.runtime.program.rules;
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      if (rule === undefined || !(yield* this.#selects(rule, index))) continue;
      if (rule.action === null) {
        this.print([]);
        yield;
        continue;
      }
      const flow = yield* this.execute(rule.action);
      if (flow === "next" || flow === "nextfile" || flow === "exit") return flow;
    }
    return "normal";
  }

  *#selects(rule: Rule, index: number): Step<boolean> {
    const pattern = rule.pattern;
    if (pattern === null) return true;
    if (pattern.kind === "expr") return truthy(yield* this.value(pattern.expr));
    if (this.#ranges[index] !== true) {
      if (!truthy(yield* this.value(pattern.from))) return false;
      this.#ranges[index] = true;
    }
    if (truthy(yield* this.value(pattern.to))) this.#ranges[index] = false;
    return true;
  }
}

/** The exit status is the value truncated to an integer; the OS keeps the low byte. */
function exitCode(value: number): number {
  if (Number.isNaN(value)) return 0;
  const clamped = Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, Math.trunc(value)));
  return clamped & 0xff;
}
