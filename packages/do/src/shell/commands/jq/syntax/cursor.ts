// Token cursor and syntax diagnostics shared by the jq parser layers:
// bison's token names, jq's located error format, and the compile-error tally.

import { CompileError } from "../errors.js";
import type { JqValue } from "../value.js";
import type { Node } from "./ast.js";
import type { Token } from "./lexer.js";

export class SyntaxFailure extends Error {
  constructor(
    readonly token: Token,
    readonly expecting: string | null,
  ) {
    super("syntax error");
  }
}
export function compileError(diagnostics: readonly string[]): CompileError {
  const count = diagnostics.length;
  return new CompileError([...diagnostics, `jq: ${count} compile error${count === 1 ? "" : "s"}`]);
}

/** locfile_locate: the message, the source line, and a caret underline. */
export function locate(
  source: string,
  span: { readonly start: number; readonly end: number },
  message: string,
): string {
  const bytes = new TextEncoder().encode(source);
  const start = new TextEncoder().encode(source.slice(0, span.start)).length;
  const end = new TextEncoder().encode(source.slice(0, span.end)).length;
  let lineStart = 0;
  let line = 1;
  for (let index = 0; index < start; index++) {
    if (bytes[index] === 0x0a) {
      line++;
      lineStart = index + 1;
    }
  }
  let lineEnd = bytes.indexOf(0x0a, lineStart);
  if (lineEnd === -1) lineEnd = bytes.length;
  const stop = Math.min(end, Math.max(lineEnd, start + 1));
  const text = new TextDecoder().decode(bytes.subarray(lineStart, lineEnd));
  const underline = `${" ".repeat(start - lineStart)}${"^".repeat(Math.max(0, stop - start))}`;
  return `jq: error: ${message} at <top-level>, line ${line}, column ${start - lineStart + 1}:\n    ${text}\n    ${underline}`;
}

export function describe(token: Token): string {
  switch (token.type) {
    case "eof":
      return "end of file";
    case "ident":
      return "IDENT";
    case "field":
      return "FIELD";
    case "binding":
      return "BINDING";
    case "format":
      return "FORMAT";
    case "number":
      return "LITERAL";
    case "string-start":
      return "QQSTRING_START";
    case "string-text":
      return "QQSTRING_TEXT";
    case "interp-start":
      return "QQSTRING_INTERP_START";
    case "interp-end":
      return "QQSTRING_INTERP_END";
    case "string-end":
      return "QQSTRING_END";
    case "invalid":
      return "INVALID_CHARACTER";
    case "punct":
      return token.text.length === 1 ? `'${token.text}'` : token.text;
    default:
      return token.text;
  }
}
export class Cursor {
  readonly diagnostics: string[] = [];
  index = 0;

  constructor(
    readonly source: string,
    readonly tokens: readonly Token[],
  ) {}

  peek(): Token {
    return this.tokens[this.index] ?? this.eof();
  }

  eof(): Token {
    const last = this.tokens[this.tokens.length - 1];
    return last ?? { type: "eof", text: "", start: 0, end: 0 };
  }

  next(): Token {
    const token = this.peek();
    if (this.index < this.tokens.length - 1) this.index++;
    return token;
  }

  at(offset: number, ...types: Token["type"][]): boolean {
    const token = this.tokens[this.index + offset];
    return token !== undefined && types.includes(token.type);
  }

  atPunct(offset: number, text: string): boolean {
    const token = this.tokens[this.index + offset];
    return token?.type === "punct" && token.text === text;
  }

  punct(text: string): boolean {
    return this.atPunct(0, text);
  }

  keyword(text: string): boolean {
    const token = this.peek();
    return token.type === "keyword" && token.text === text;
  }

  /** `$__loc__`: the file and one-based line of the token. */
  location(token: Token): Node {
    let line = 1;
    for (let index = 0; index < token.start; index++) {
      if (this.source.charCodeAt(index) === 0x0a) line++;
    }
    return {
      kind: "literal",
      value: new Map<string, JqValue>([
        ["file", "<top-level>"],
        ["line", line],
      ]),
    };
  }

  expect(type: Token["type"], expecting: string | null = null): Token {
    const token = this.peek();
    if (token.type !== type) throw new SyntaxFailure(token, expecting);
    return this.next();
  }

  expectPunct(text: string, expecting: string | null = null): Token {
    if (!this.punct(text)) throw new SyntaxFailure(this.peek(), expecting);
    return this.next();
  }

  expectKeyword(text: string): Token {
    if (!this.keyword(text)) throw new SyntaxFailure(this.peek(), null);
    return this.next();
  }
}
