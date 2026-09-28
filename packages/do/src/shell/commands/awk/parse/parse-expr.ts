// awk expressions, with the precedences mawk accepts.
//
// Low to high: `?:`, `||`, `&&`, `in`, `~ !~`, comparisons, concatenation,
// `+ -`, `* / %`, unary `! - +`, `^`, `++ --`, and `$`. An assignment may start
// any operand at the comparison level or below it, never inside arithmetic or
// concatenation: `a == b = c` assigns, `1 + b = c` is a syntax error.

import { parseRegex, RegexSyntaxError } from "../regex/regex-parse.js";
import type { CompareOp, Expr, LValue } from "./ast.js";
import { ParserBase } from "./parse-base.js";
import type { Token } from "./tokens.js";

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "^="]);
const COMPARE_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);

/** Tokens that may begin a concatenated operand. */
function startsOperand(token: Token): boolean {
  switch (token.kind) {
    case "number":
    case "string":
    case "regex":
    case "name":
    case "funcname":
    case "builtin":
    case "field":
    case "$":
    case "(":
    case "!":
    case "-":
    case "+":
    case "++":
    case "--":
      return true;
    case "keyword":
      return ["length", "split", "sub", "gsub", "match", "getline"].includes(token.value);
    default:
      return false;
  }
}

function isLValue(expr: Expr): expr is LValue {
  return expr.kind === "variable" || expr.kind === "element" || expr.kind === "field";
}

export abstract class ExpressionParser extends ParserBase {
  protected abstract call(): Expr;
  protected abstract builtin(): Expr;
  protected abstract keywordExpression(token: Token): Expr;

  expression(): Expr {
    return this.nested(() => this.ternary());
  }

  private ternary(): Expr {
    const test = this.binary(0);
    if (!this.is("?")) return test;
    this.advance();
    const then = this.nested(() => this.ternary());
    this.expect(":");
    const otherwise = this.nested(() => this.ternary());
    return { kind: "conditional", test, then, otherwise };
  }

  /** Levels 0 `||`, 1 `&&`, 2 `in`, 3 `~ !~`, 4 comparisons; above that, concatenation. */
  private binary(level: number): Expr {
    if (level > 4) return this.operand();
    let left = this.binary(level + 1);
    for (;;) {
      const token = this.token;
      if (level === 0 && token.kind === "||") {
        this.advance();
        left = { kind: "or", left, right: this.binary(1) };
      } else if (level === 1 && token.kind === "&&") {
        this.advance();
        left = { kind: "and", left, right: this.binary(2) };
      } else if (level === 2 && token.kind === "keyword" && token.value === "in") {
        this.advance();
        const name = this.expect("name");
        left = { kind: "in", subscripts: [left], array: this.useArray(name.value, name) };
      } else if (level === 3 && (token.kind === "~" || token.kind === "!~")) {
        this.advance();
        const pattern = this.binary(4);
        left = { kind: "match", negated: token.kind === "!~", subject: left, pattern };
      } else if (level === 4 && COMPARE_OPS.has(token.kind)) {
        this.advance();
        left = { kind: "compare", op: compareOp(token.kind), left, right: this.binary(5) };
      } else {
        return left;
      }
    }
  }

  /** An operand at the comparison level: an assignment, or a concatenation. */
  private operand(): Expr {
    const start = this.position;
    const target = this.tryLValue();
    if (target !== null && ASSIGN_OPS.has(this.token.kind)) {
      const op = this.advance().kind;
      const value = this.expression();
      return { kind: "assign", op: assignOp(op), target, value };
    }
    this.position = start;
    return this.concatenation();
  }

  /** An lvalue at the cursor, consumed, or null with the cursor unchanged. */
  private tryLValue(): LValue | null {
    const start = this.position;
    const token = this.token;
    if (token.kind === "name") {
      const next = this.peek(1);
      if (next.kind === "[") {
        this.advance();
        return this.element(token);
      }
      if (ASSIGN_OPS.has(next.kind)) {
        this.advance();
        return { kind: "variable", ref: this.useScalar(token.value, token) };
      }
      return null;
    }
    if (token.kind === "field" || token.kind === "$") {
      const field = this.field();
      if (ASSIGN_OPS.has(this.token.kind)) return field;
    }
    this.position = start;
    return null;
  }

  private concatenation(): Expr {
    let left = this.additive();
    while (startsOperand(this.token)) {
      left = { kind: "concat", left, right: this.additive() };
    }
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    while (this.is("+") || this.is("-")) {
      const op = this.advance().kind === "+" ? "+" : "-";
      left = { kind: "arithmetic", op, left, right: this.multiplicative() };
    }
    return left;
  }

  private multiplicative(): Expr {
    let left = this.unary();
    while (this.is("*") || this.is("/") || this.is("%")) {
      const kind = this.advance().kind;
      const op = kind === "*" ? "*" : kind === "/" ? "/" : "%";
      left = { kind: "arithmetic", op, left, right: this.unary() };
    }
    return left;
  }

  private unary(): Expr {
    const token = this.token;
    if (token.kind === "!" || token.kind === "-" || token.kind === "+") {
      this.advance();
      const operand = this.nested(() => this.unary());
      const kind = token.kind === "!" ? "not" : token.kind === "-" ? "negate" : "plus";
      return { kind, operand };
    }
    return this.power();
  }

  private power(): Expr {
    const base = this.postfix();
    if (!this.is("^")) return base;
    this.advance();
    const exponent = this.nested(() => this.powerOperand());
    return { kind: "arithmetic", op: "^", left: base, right: exponent };
  }

  /** `^` is right-associative, and its right side may be a unary minus. */
  private powerOperand(): Expr {
    const token = this.token;
    if (token.kind === "!" || token.kind === "-" || token.kind === "+") {
      this.advance();
      const operand = this.nested(() => this.powerOperand());
      const kind = token.kind === "!" ? "not" : token.kind === "-" ? "negate" : "plus";
      return { kind, operand };
    }
    return this.power();
  }

  private postfix(): Expr {
    const token = this.token;
    if (token.kind === "++" || token.kind === "--") {
      this.advance();
      const target = this.incrementTarget();
      return { kind: "increment", delta: token.kind === "++" ? 1 : -1, prefix: true, target };
    }
    const expr = this.primary();
    if ((this.is("++") || this.is("--")) && isLValue(expr)) {
      const delta = this.advance().kind === "++" ? 1 : -1;
      return { kind: "increment", delta, prefix: false, target: expr };
    }
    return expr;
  }

  private incrementTarget(): LValue {
    const token = this.token;
    if (token.kind === "name") {
      this.advance();
      if (this.is("[")) return this.element(token);
      return { kind: "variable", ref: this.useScalar(token.value, token) };
    }
    if (token.kind === "field" || token.kind === "$") return this.field();
    throw this.syntaxError();
  }

  element(name: Token): LValue {
    const array = this.useArray(name.value, name);
    this.expect("[");
    const subscripts = this.list("]");
    return { kind: "element", array, subscripts };
  }

  /** Comma-separated expressions up to `close`, which is consumed. */
  list(close: ")" | "]"): Expr[] {
    const items = [this.expression()];
    while (this.is(",")) {
      this.advance();
      items.push(this.expression());
    }
    this.expect(close);
    return items;
  }

  field(): LValue {
    const token = this.advance();
    if (token.kind === "field")
      return { kind: "field", index: { kind: "number", value: token.number } };
    const next = this.token;
    if (next.kind === "name") {
      this.advance();
      if (this.is("[")) return { kind: "field", index: this.element(next) };
      return { kind: "field", index: { kind: "variable", ref: this.useScalar(next.value, next) } };
    }
    return { kind: "field", index: this.nested(() => this.dollarOperand()) };
  }

  /** The operand of `$`, which binds tighter than everything but grouping. */
  private dollarOperand(): Expr {
    const token = this.token;
    if (token.kind === "-" || token.kind === "+" || token.kind === "!") {
      this.advance();
      const operand = this.unary();
      const kind = token.kind === "!" ? "not" : token.kind === "-" ? "negate" : "plus";
      return { kind, operand };
    }
    if (token.kind === "++" || token.kind === "--") return this.postfix();
    return this.primary();
  }

  private primary(): Expr {
    const token = this.token;
    switch (token.kind) {
      case "number":
        this.advance();
        return { kind: "number", value: token.number };
      case "string":
        this.advance();
        return { kind: "string", value: token.value };
      case "regex":
        this.advance();
        try {
          parseRegex(token.value);
        } catch (error) {
          if (!(error instanceof RegexSyntaxError)) throw error;
          throw this.error(
            `regular expression compile failed (${error.message})\n${token.value}`,
            token,
          );
        }
        return { kind: "regex", source: token.value, line: token.line };
      case "field":
      case "$":
        return this.field();
      case "(":
        return this.group();
      case "name":
        this.advance();
        if (this.is("[")) return this.element(token);
        return { kind: "variable", ref: this.useScalar(token.value, token) };
      case "funcname":
        return this.call();
      case "builtin":
        return this.builtin();
      case "keyword":
        return this.keywordExpression(token);
      default:
        throw this.syntaxError();
    }
  }

  private group(): Expr {
    this.advance();
    const first = this.expression();
    if (this.is(")")) {
      this.advance();
      return first;
    }
    if (!this.is(",")) throw this.syntaxError();
    const subscripts = [first];
    while (this.is(",")) {
      this.advance();
      subscripts.push(this.expression());
    }
    this.expect(")");
    if (!this.isKeyword("in")) throw this.syntaxError();
    this.advance();
    const name = this.expect("name");
    return { kind: "in", subscripts, array: this.useArray(name.value, name) };
  }
}

function compareOp(kind: string): CompareOp {
  switch (kind) {
    case "==":
      return "==";
    case "!=":
      return "!=";
    case "<":
      return "<";
    case "<=":
      return "<=";
    case ">":
      return ">";
    default:
      return ">=";
  }
}

function assignOp(kind: string): "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "^=" {
  switch (kind) {
    case "+=":
      return "+=";
    case "-=":
      return "-=";
    case "*=":
      return "*=";
    case "/=":
      return "/=";
    case "%=":
      return "%=";
    case "^=":
      return "^=";
    default:
      return "=";
  }
}
