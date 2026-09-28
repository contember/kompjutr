// The jq grammar (src/parser.y) as recursive descent. Query-level forms
// (`def`, `label`, `as`) extend to the end of the enclosing query; binary
// operators follow parser.y's precedence table; postfix suffixes bind tighter
// than unary minus, which applies to a whole term.

import { JqRefusal } from "../errors.js";
import type { Definition, Node } from "./ast.js";
import { IDENTITY } from "./ast.js";
import { compileError, describe, locate, SyntaxFailure } from "./cursor.js";
import { type Token, tokenize } from "./lexer.js";
import { Structures } from "./structures.js";

export { compileError, locate };

interface Level {
  readonly operators: readonly string[];
  readonly associativity: "left" | "right" | "none";
}

const LEVELS: readonly Level[] = [
  { operators: ["//"], associativity: "right" },
  { operators: ["=", "|=", "+=", "-=", "*=", "/=", "%=", "//="], associativity: "none" },
  { operators: ["or"], associativity: "left" },
  { operators: ["and"], associativity: "left" },
  { operators: ["==", "!=", "<", "<=", ">", ">="], associativity: "none" },
  { operators: ["+", "-"], associativity: "left" },
  { operators: ["*", "/", "%"], associativity: "left" },
];

export function parseProgram(source: string): Node {
  const parser = new Parser(source, tokenize(source));
  let program: Node | null;
  try {
    program = parser.program();
  } catch (error) {
    if (!(error instanceof SyntaxFailure)) throw error;
    const expecting = error.expecting === null ? "" : `, expecting ${error.expecting}`;
    const message = `syntax error, unexpected ${describe(error.token)}${expecting}`;
    throw compileError([locate(source, error.token, message)]);
  }
  if (parser.diagnostics.length > 0) throw compileError(parser.diagnostics);
  if (program === null) {
    throw compileError(['jq: error: Top-level program not given (try ".")']);
  }
  return program;
}

/** A library of definitions and nothing else, as jq's builtin.jq is. */
export function parseDefinitions(source: string): Definition[] {
  const parser = new Parser(source, tokenize(source));
  const definitions = parser.definitions();
  if (parser.diagnostics.length > 0) throw compileError(parser.diagnostics);
  return definitions;
}

class Parser extends Structures {
  program(): Node | null {
    if (this.keyword("module") || this.keyword("import") || this.keyword("include")) {
      throw new JqRefusal("modules (import, include, module) are not supported");
    }
    const definitions: Definition[] = [];
    while (this.keyword("def")) definitions.push(this.definition());
    if (this.peek().type === "eof") return null;
    let body = this.query();
    if (this.peek().type !== "eof") throw new SyntaxFailure(this.peek(), "end of file");
    for (const definition of definitions.reverse()) body = { kind: "define", definition, body };
    return body;
  }

  definitions(): Definition[] {
    const definitions: Definition[] = [];
    while (this.keyword("def")) definitions.push(this.definition());
    if (this.peek().type !== "eof") throw new SyntaxFailure(this.peek(), "end of file");
    return definitions;
  }

  query(): Node {
    if (this.keyword("def")) {
      const definition = this.definition();
      return { kind: "define", definition, body: this.query() };
    }
    if (this.keyword("label")) {
      this.next();
      const name = this.expect("binding");
      this.expectPunct("|");
      return { kind: "label", name: name.text.slice(1), body: this.query() };
    }
    const left = this.commaLevel();
    if (!this.punct("|")) return left;
    this.next();
    return { kind: "pipe", left, right: this.query() };
  }

  commaLevel(): Node {
    let left = this.bindingLevel();
    while (this.punct(",")) {
      this.next();
      left = { kind: "comma", left, right: this.bindingLevel() };
    }
    return left;
  }

  bindingLevel(): Node {
    if (this.keyword("def") || this.keyword("label")) return this.query();
    const source = this.expression(0);
    if (!this.keyword("as")) return source;
    this.next();
    const pattern = this.patterns();
    this.expectPunct("|");
    return { kind: "bind", source, pattern, body: this.query() };
  }

  expression(level: number): Node {
    const spec = LEVELS[level];
    if (spec === undefined) return this.term();
    let left = this.expression(level + 1);
    for (;;) {
      const token = this.peek();
      const isOperator =
        (token.type === "punct" || token.type === "keyword") && spec.operators.includes(token.text);
      if (!isOperator) return left;
      this.next();
      if (spec.associativity === "right") return combine(token.text, left, this.expression(level));
      left = combine(token.text, left, this.expression(level + 1));
      if (spec.associativity === "none") {
        const after = this.peek();
        if (
          (after.type === "punct" || after.type === "keyword") &&
          spec.operators.includes(after.text)
        ) {
          throw new SyntaxFailure(after, null);
        }
        return left;
      }
    }
  }

  term(): Node {
    if (this.punct("-")) {
      this.next();
      return { kind: "negate", body: this.term() };
    }
    let term = this.primary();
    for (;;) {
      const token = this.peek();
      if (token.type === "field") {
        this.next();
        term = this.optionalIndex(term, { kind: "literal", value: token.text.slice(1) });
      } else if (
        token.type === "punct" &&
        token.text === "." &&
        this.at(1, "string-start", "format")
      ) {
        this.next();
        term = this.optionalIndex(term, this.string());
      } else if (token.type === "punct" && token.text === "." && this.atPunct(1, "[")) {
        this.next();
        term = this.bracket(term);
      } else if (this.punct("[")) term = this.bracket(term);
      else if (this.punct("?")) {
        this.next();
        term = { kind: "try", body: term, handler: null };
      } else return term;
    }
  }

  optionalIndex(target: Node, key: Node): Node {
    const optional = this.punct("?");
    if (optional) this.next();
    return { kind: "index", target, key, optional };
  }

  bracket(target: Node): Node {
    this.expectPunct("[");
    let node: Node;
    if (this.punct("]")) node = { kind: "iterate", target, optional: false };
    else if (this.punct(":")) {
      this.next();
      node = { kind: "slice", target, from: null, to: this.query(), optional: false };
    } else {
      const key = this.query();
      if (this.punct(":")) {
        this.next();
        const to = this.punct("]") ? null : this.query();
        node = { kind: "slice", target, from: key, to, optional: false };
      } else node = { kind: "index", target, key, optional: false };
    }
    this.expectPunct("]", node.kind === "index" ? "'|' or ',' or ':' or ']'" : "'|' or ',' or ']'");
    if (!this.punct("?")) return node;
    this.next();
    return { ...node, optional: true };
  }

  primary(): Node {
    const token = this.peek();
    switch (token.type) {
      case "number":
        this.next();
        return { kind: "literal", value: token.value ?? null };
      case "string-start":
        return this.string();
      case "format":
        if (this.at(1, "string-start")) return this.string();
        this.next();
        return { kind: "format", name: token.text.slice(1) };
      case "field":
        this.next();
        return this.optionalIndex(IDENTITY, { kind: "literal", value: token.text.slice(1) });
      case "binding":
        this.next();
        return { kind: "variable", name: token.text.slice(1), start: token.start, end: token.end };
      case "loc":
        this.next();
        return this.location(token);
      case "ident":
        return this.call();
      case "keyword":
        return this.keywordTerm(token);
      case "punct":
        return this.punctTerm(token);
      default:
        throw new SyntaxFailure(token, null);
    }
  }

  punctTerm(token: Token): Node {
    switch (token.text) {
      case ".":
        this.next();
        if (this.at(0, "string-start", "format"))
          return this.optionalIndex(IDENTITY, this.string());
        return IDENTITY;
      case "..":
        this.next();
        return { kind: "call", name: "recurse", args: [], start: token.start, end: token.end };
      case "(": {
        this.next();
        const body = this.query();
        this.expectPunct(")", "'|' or ',' or ')'");
        return body;
      }
      case "[": {
        this.next();
        if (this.punct("]")) {
          this.next();
          return { kind: "array", body: null };
        }
        const body = this.query();
        this.expectPunct("]", "'|' or ',' or ']'");
        return { kind: "array", body };
      }
      case "{":
        return this.object();
      default:
        throw new SyntaxFailure(token, null);
    }
  }

  keywordTerm(token: Token): Node {
    switch (token.text) {
      case "if":
        return this.conditional();
      case "try": {
        this.next();
        const body = this.term();
        if (!this.keyword("catch")) return { kind: "try", body, handler: null };
        this.next();
        return { kind: "try", body, handler: this.term() };
      }
      case "reduce":
      case "foreach":
        return this.fold(token.text);
      case "break": {
        this.next();
        const name = this.expect("binding");
        return { kind: "break", name: name.text.slice(1), start: token.start, end: name.end };
      }
      default:
        throw new SyntaxFailure(token, null);
    }
  }

  conditional(): Node {
    this.next();
    const condition = this.query();
    this.expectKeyword("then");
    const then = this.query();
    if (this.keyword("elif")) return { kind: "if", condition, then, otherwise: this.conditional() };
    if (this.keyword("else")) {
      this.next();
      const otherwise = this.query();
      this.expectKeyword("end");
      return { kind: "if", condition, then, otherwise };
    }
    this.expectKeyword("end");
    return { kind: "if", condition, then, otherwise: null };
  }

  fold(keyword: string): Node {
    this.next();
    const source = this.expression(0);
    this.expectKeyword("as");
    const pattern = this.patterns();
    this.expectPunct("(", "'('");
    const init = this.query();
    this.expectPunct(";");
    const update = this.query();
    if (keyword === "reduce") {
      this.expectPunct(")");
      return { kind: "reduce", source, pattern, init, update };
    }
    let extract: Node | null = null;
    if (this.punct(";")) {
      this.next();
      extract = this.query();
    }
    this.expectPunct(")");
    return { kind: "foreach", source, pattern, init, update, extract };
  }

  call(): Node {
    const token = this.next();
    if (token.text === "true" || token.text === "false")
      return { kind: "literal", value: token.text === "true" };
    if (token.text === "null") return { kind: "literal", value: null };
    const args: Node[] = [];
    if (this.punct("(")) {
      this.next();
      args.push(this.query());
      while (this.punct(";")) {
        this.next();
        args.push(this.query());
      }
      this.expectPunct(")");
    }
    return { kind: "call", name: token.text, args, start: token.start, end: token.end };
  }
}

function combine(operator: string, left: Node, right: Node): Node {
  switch (operator) {
    case "//":
      return { kind: "alternative", left, right };
    case "and":
      return { kind: "and", left, right };
    case "or":
      return { kind: "or", left, right };
    case "=":
    case "|=":
    case "+=":
    case "-=":
    case "*=":
    case "/=":
    case "%=":
    case "//=":
      return { kind: "assign", operator, left, right };
    case "+":
    case "-":
    case "*":
    case "/":
    case "%":
    case "==":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=":
      return { kind: "binary", operator, left, right };
    default:
      throw new Error(`unknown operator ${operator}`);
  }
}
