// Function calls and the builtins with their own grammar: `length` with or
// without parentheses, `split` into a named array, `sub`/`gsub` into an
// lvalue, and `match`. Builtins mawk has but this shell cannot honour —
// `system`, `close`, `rand`, the clock — are refused by name.

import type { CallArgument, Expr, LValue } from "./ast.js";
import { ExpressionParser } from "./parse-expr.js";
import type { Token } from "./tokens.js";

/** Builtin argument counts: the minimum and maximum mawk accepts. */
const ARITY: ReadonlyMap<string, readonly [number, number]> = new Map([
  ["index", [2, 2]],
  ["substr", [2, 3]],
  ["sprintf", [1, 255]],
  ["sin", [1, 1]],
  ["cos", [1, 1]],
  ["atan2", [2, 2]],
  ["exp", [1, 1]],
  ["log", [1, 1]],
  ["int", [1, 1]],
  ["sqrt", [1, 1]],
  ["toupper", [1, 1]],
  ["tolower", [1, 1]],
  ["fflush", [0, 1]],
]);

const REFUSED_BUILTINS: ReadonlyMap<string, string> = new Map([
  ["rand", "`rand' is not supported: mawk's random sequence cannot be reproduced"],
  ["srand", "`srand' is not supported: mawk's random sequence cannot be reproduced"],
  ["system", "`system' is not supported: awk cannot run commands"],
  ["close", "`close' is not supported: there are no files or pipes to close"],
  ["systime", "`systime' is not supported: the shell's clock is not exposed to awk"],
  ["mktime", "`mktime' is not supported: the shell's clock is not exposed to awk"],
  ["strftime", "`strftime' is not supported: the shell's clock is not exposed to awk"],
]);

export const GETLINE_REFUSAL = "`getline' is not supported: input is read only by the main loop";

export interface PendingCall {
  readonly name: string;
  readonly args: readonly CallArgument[];
  readonly line: number;
  /** The function the call appears in, or null in BEGIN, END, and rules. */
  readonly caller: string | null;
  readonly token: Token;
}

export abstract class CallParser extends ExpressionParser {
  readonly calls: PendingCall[] = [];
  currentFunction: string | null = null;

  protected call(): Expr {
    const token = this.advance();
    this.expect("(");
    const args: CallArgument[] = [];
    if (this.is(")")) this.advance();
    else {
      for (;;) {
        const name = this.token;
        const after = this.peek(1).kind;
        if (
          name.kind === "name" &&
          (after === "," || after === ")") &&
          !this.isSpecialName(name.value)
        ) {
          this.advance();
          args.push({ kind: "name", slot: this.useUntyped(name.value) });
        } else {
          args.push({ kind: "expr", expr: this.expression() });
        }
        if (this.is(")")) {
          this.advance();
          break;
        }
        this.expect(",");
      }
    }
    const pending: PendingCall = {
      name: token.value,
      args,
      line: token.line,
      caller: this.currentFunction,
      token,
    };
    this.calls.push(pending);
    return { kind: "call", name: token.value, args, line: token.line };
  }

  protected builtin(): Expr {
    const token = this.advance();
    const refusal = REFUSED_BUILTINS.get(token.value);
    if (refusal !== undefined) throw this.refuse(refusal, token);
    this.expect("(");
    const args: Expr[] = this.is(")") ? [] : this.list(")").slice();
    if (args.length === 0) this.advance();
    const [min, max] = ARITY.get(token.value) ?? [0, 0];
    if (args.length < min) {
      throw this.error(
        `not enough arguments in call to ${token.value}: ${args.length} (need ${min})`,
        token,
      );
    }
    if (args.length > max) {
      throw this.error(
        `too many arguments in call to ${token.value}: ${args.length} (maximum ${max})`,
        token,
      );
    }
    return { kind: "builtin", name: token.value, args };
  }

  protected keywordExpression(token: Token): Expr {
    switch (token.value) {
      case "length":
        return this.length();
      case "split": {
        this.advance();
        this.expect("(");
        const source = this.expression();
        this.expect(",");
        const name = this.expect("name");
        const array = this.useArray(name.value, name);
        let separator: Expr | null = null;
        if (this.is(",")) {
          this.advance();
          separator = this.expression();
        }
        this.expect(")");
        return { kind: "split", source, array, separator };
      }
      case "sub":
      case "gsub": {
        this.advance();
        this.expect("(");
        const pattern = this.expression();
        this.expect(",");
        const replacement = this.expression();
        let target: LValue = { kind: "field", index: { kind: "number", value: 0 } };
        if (this.is(",")) {
          this.advance();
          const candidate = this.tryTarget();
          if (candidate === null) throw this.syntaxError();
          target = candidate;
        }
        this.expect(")");
        return { kind: "substitute", global: token.value === "gsub", pattern, replacement, target };
      }
      case "match": {
        this.advance();
        this.expect("(");
        const subject = this.expression();
        this.expect(",");
        const pattern = this.expression();
        this.expect(")");
        return { kind: "matchFunction", subject, pattern };
      }
      case "getline":
        throw this.refuse(GETLINE_REFUSAL, token);
      default:
        throw this.syntaxError();
    }
  }

  /** The third argument of `sub`/`gsub`: a variable, element, or field. */
  private tryTarget(): LValue | null {
    const token = this.token;
    if (token.kind === "name") {
      this.advance();
      if (this.is("[")) return this.element(token);
      return { kind: "variable", ref: this.useScalar(token.value, token) };
    }
    if (token.kind === "field" || token.kind === "$") return this.field();
    if (token.kind === "(") {
      this.advance();
      const inner = this.tryTarget();
      this.expect(")");
      return inner;
    }
    return null;
  }

  private length(): Expr {
    this.advance();
    const dollarZero: Expr = { kind: "field", index: { kind: "number", value: 0 } };
    if (!this.is("(")) return { kind: "builtin", name: "length", args: [dollarZero] };
    this.advance();
    if (this.is(")")) {
      this.advance();
      return { kind: "builtin", name: "length", args: [dollarZero] };
    }
    const name = this.token;
    if (name.kind === "name" && this.peek(1).kind === ")" && !this.isSpecialName(name.value)) {
      this.advance();
      this.advance();
      const { slot, entry } = this.slotOf(name.value);
      if (entry.kind === "array") return { kind: "arrayLength", array: slot };
      if (entry.kind === "scalar")
        return { kind: "builtin", name: "length", args: [{ kind: "variable", ref: slot }] };
      return { kind: "lengthOfName", slot };
    }
    const arg = this.expression();
    this.expect(")");
    return { kind: "builtin", name: "length", args: [arg] };
  }
}
