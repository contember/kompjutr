// The compound forms of the jq grammar: strings with interpolation, object
// construction, destructuring patterns, and `def`. They recurse into
// `query` and `expression`, which the parser supplies.

import { truncatedDump } from "../dump.js";
import { JqRefusal } from "../errors.js";
import { kindOf } from "../value.js";
import type {
  Definition,
  Node,
  ObjectEntry,
  ObjectPatternEntry,
  Parameter,
  Pattern,
} from "./ast.js";
import { IDENTITY } from "./ast.js";
import { Cursor, locate, SyntaxFailure } from "./cursor.js";

export abstract class Structures extends Cursor {
  abstract query(): Node;
  abstract expression(level: number): Node;

  string(): Node {
    let format: string | null = null;
    if (this.peek().type === "format") format = this.next().text.slice(1);
    this.expect("string-start");
    const parts: Array<string | Node> = [];
    for (;;) {
      const token = this.peek();
      if (token.type === "string-end") {
        this.next();
        break;
      }
      if (token.type === "string-text") {
        this.next();
        if (token.error !== undefined)
          this.diagnostics.push(locate(this.source, token, token.error));
        parts.push(typeof token.value === "string" ? token.value : "");
      } else if (token.type === "interp-start") {
        this.next();
        parts.push(this.query());
        this.expect("interp-end", "QQSTRING_INTERP_END or '|' or ','");
      } else throw new SyntaxFailure(token, null);
    }
    return { kind: "string", format, parts };
  }

  object(): Node {
    this.expectPunct("{");
    const entries: ObjectEntry[] = [];
    while (!this.punct("}")) {
      entries.push(this.objectEntry());
      if (!this.punct(",")) break;
      this.next();
    }
    this.expectPunct("}", "'}'");
    return { kind: "object", entries };
  }

  objectEntry(): ObjectEntry {
    const token = this.peek();
    if (token.type === "ident" || token.type === "keyword") {
      this.next();
      const key: Node = { kind: "literal", value: token.text };
      return {
        key,
        value: this.punct(":")
          ? this.dictValue()
          : { kind: "index", target: IDENTITY, key, optional: false },
      };
    }
    if (token.type === "binding") {
      this.next();
      const variable: Node = {
        kind: "variable",
        name: token.text.slice(1),
        start: token.start,
        end: token.end,
      };
      if (this.punct(":")) return { key: variable, value: this.dictValue() };
      return { key: { kind: "literal", value: token.text.slice(1) }, value: variable };
    }
    if (token.type === "loc") {
      this.next();
      return { key: { kind: "literal", value: "__loc__" }, value: this.location(token) };
    }
    if (token.type === "string-start" || token.type === "format") {
      const key = this.string();
      return {
        key,
        value: this.punct(":")
          ? this.dictValue()
          : { kind: "index", target: IDENTITY, key, optional: false },
      };
    }
    if (this.punct("(")) {
      this.next();
      const first = this.peek();
      const key = this.query();
      const last = this.tokens[this.index - 1] ?? first;
      this.expectPunct(")");
      if (!this.punct(":")) throw new SyntaxFailure(this.peek(), "':'");
      if (key.kind === "literal" && typeof key.value !== "string") {
        const message = `Cannot use ${kindOf(key.value)} (${truncatedDump(key.value)}) as object key`;
        this.diagnostics.push(locate(this.source, { start: first.start, end: last.end }, message));
      }
      return { key, value: this.dictValue() };
    }
    throw new SyntaxFailure(token, null);
  }

  dictValue(): Node {
    this.expectPunct(":");
    let value = this.expression(0);
    while (this.punct("|")) {
      this.next();
      value = { kind: "pipe", left: value, right: this.expression(0) };
    }
    return value;
  }

  patterns(): Pattern {
    const pattern = this.pattern();
    if (this.punct("?//"))
      throw new JqRefusal("destructuring alternatives (?//) are not supported");
    return pattern;
  }

  pattern(): Pattern {
    const token = this.peek();
    if (token.type === "binding") {
      this.next();
      return { kind: "variable", name: token.text.slice(1), start: token.start, end: token.end };
    }
    if (this.punct("[")) {
      this.next();
      const items = [this.pattern()];
      while (this.punct(",")) {
        this.next();
        items.push(this.pattern());
      }
      this.expectPunct("]");
      return { kind: "array", items };
    }
    if (this.punct("{")) {
      this.next();
      const entries = [this.objectPattern()];
      while (this.punct(",")) {
        this.next();
        entries.push(this.objectPattern());
      }
      this.expectPunct("}");
      return { kind: "object", entries };
    }
    throw new SyntaxFailure(token, "BINDING or '[' or '{'");
  }

  objectPattern(): ObjectPatternEntry {
    const token = this.peek();
    if (token.type === "binding") {
      this.next();
      const binding = { name: token.text.slice(1), start: token.start, end: token.end };
      const key: Node = { kind: "literal", value: binding.name };
      if (!this.punct(":")) return { key, binding, pattern: null };
      this.next();
      return { key, binding, pattern: this.pattern() };
    }
    let key: Node;
    if (token.type === "ident" || token.type === "keyword") {
      this.next();
      key = { kind: "literal", value: token.text };
    } else if (token.type === "string-start" || token.type === "format") key = this.string();
    else if (this.punct("(")) {
      this.next();
      key = this.query();
      this.expectPunct(")");
    } else throw new SyntaxFailure(token, null);
    this.expectPunct(":");
    return { key, binding: null, pattern: this.pattern() };
  }

  definition(): Definition {
    const start = this.next();
    const name = this.expect("ident");
    const params: Parameter[] = [];
    if (this.punct("(")) {
      this.next();
      params.push(this.parameter());
      while (this.punct(";")) {
        this.next();
        params.push(this.parameter());
      }
      this.expectPunct(")");
    }
    this.expectPunct(":");
    const body = this.query();
    const end = this.expectPunct(";");
    return { name: name.text, params, body, start: start.start, end: end.end };
  }

  parameter(): Parameter {
    const token = this.peek();
    if (token.type === "binding") {
      this.next();
      return { name: token.text.slice(1), value: true };
    }
    return { name: this.expect("ident").text, value: false };
  }
}
