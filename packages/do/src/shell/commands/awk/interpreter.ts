// Statement execution. Each statement is a generator that yields after it
// writes output, so the driver can flush between statements and a consumer
// that stops reading (`awk … | head`) stops the program. Function bodies run
// to completion synchronously; their output waits in the reserved buffer.

import { formatted } from "./builtins.js";
import { Evaluator, type Flow } from "./evaluate.js";
import type { Rule, Statement } from "./parse/ast.js";
import { ELEMENT_OVERHEAD, type Runtime } from "./runtime.js";
import { byteLength, toNumber, toOutputText, toText, truthy, type Value } from "./values.js";

export type Step = Generator<undefined, Flow, undefined>;

export class Interpreter extends Evaluator {
  exitStatus = 0;
  readonly #ranges: boolean[];

  constructor(runtime: Runtime) {
    super(runtime);
    this.#ranges = runtime.program.rules.map(() => false);
  }

  runBody(body: Statement): Flow {
    const step = this.execute(body);
    for (;;) {
      const next = step.next();
      if (next.done === true) return next.value;
    }
  }

  *execute(statement: Statement): Step {
    switch (statement.kind) {
      case "expr":
        this.evaluate(statement.expr);
        return "normal";
      case "print":
        this.print(statement.args.map((arg) => this.evaluate(arg)));
        yield;
        return "normal";
      case "printf":
        this.runtime.output.write(
          formatted(
            this.runtime,
            "printf",
            statement.args.map((arg) => this.evaluate(arg)),
          ),
        );
        yield;
        return "normal";
      case "if": {
        const branch = truthy(this.evaluate(statement.test)) ? statement.then : statement.otherwise;
        return branch === null ? "normal" : yield* this.execute(branch);
      }
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
        if (statement.value !== null)
          this.exitStatus = exitCode(toNumber(this.evaluate(statement.value)));
        return "exit";
      case "return": {
        const value = statement.value === null ? null : this.evaluate(statement.value);
        if (this.frame !== null) this.frame.returned = value;
        return "return";
      }
      case "delete":
        this.delete(statement);
        return "normal";
    }
  }

  private delete(statement: Extract<Statement, { kind: "delete" }>): void {
    const array = this.array(statement.array);
    if (statement.subscripts === null) {
      this.runtime.clearArray(array);
      return;
    }
    const subscript = this.subscriptOf(statement.subscripts);
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
  *rules(): Step {
    const rules = this.runtime.program.rules;
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      if (rule === undefined || !this.#selects(rule, index)) continue;
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

  #selects(rule: Rule, index: number): boolean {
    const pattern = rule.pattern;
    if (pattern === null) return true;
    if (pattern.kind === "expr") return truthy(this.evaluate(pattern.expr));
    if (this.#ranges[index] !== true) {
      if (!truthy(this.evaluate(pattern.from))) return false;
      this.#ranges[index] = true;
    }
    if (truthy(this.evaluate(pattern.to))) this.#ranges[index] = false;
    return true;
  }
}

/** The exit status is the value truncated to an integer; the OS keeps the low byte. */
function exitCode(value: number): number {
  if (Number.isNaN(value)) return 0;
  const clamped = Math.max(-(2 ** 31), Math.min(2 ** 31 - 1, Math.trunc(value)));
  return clamped & 0xff;
}
