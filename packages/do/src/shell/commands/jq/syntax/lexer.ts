// The jq lexer (src/lexer.l). Strings are lexed in a mode of their own and
// come out as start/text/interpolation/end tokens; a `)` closes an
// interpolation only when the innermost open bracket is one.

import { decodeEscapes } from "../json-parse.js";
import type { JqLiteral } from "../value.js";
import { parseLiteral } from "../value.js";

export type TokenType =
  | "punct"
  | "keyword"
  | "ident"
  | "field"
  | "binding"
  | "loc"
  | "format"
  | "number"
  | "string-start"
  | "string-text"
  | "interp-start"
  | "interp-end"
  | "string-end"
  | "invalid"
  | "eof";

export interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Decoded text of a string-text token, or the literal of a number. */
  readonly value?: string | JqLiteral | number;
  /** A string-text token whose escapes jq's JSON parser rejected. */
  readonly error?: string;
}

const KEYWORDS = new Set([
  "as",
  "import",
  "include",
  "module",
  "def",
  "if",
  "then",
  "else",
  "elif",
  "and",
  "or",
  "end",
  "reduce",
  "foreach",
  "try",
  "catch",
  "label",
  "break",
]);

const OPERATORS = [
  "?//",
  "//=",
  "!=",
  "==",
  "//",
  "|=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "<=",
  ">=",
  "..",
];
const SINGLE = new Set([".", "?", "=", ";", ",", ":", "|", "+", "-", "*", "/", "%", "$", "<", ">"]);
const NAME = /[a-zA-Z_][a-zA-Z_0-9]*/y;
const QUALIFIED = /(?:[a-zA-Z_][a-zA-Z_0-9]*::)*[a-zA-Z_][a-zA-Z_0-9]*/y;
const NUMBER = /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const WHITESPACE = /[ \r\n\t]+/y;
const ESCAPES = /(?:\\[^u(]|\\u[a-zA-Z0-9]{0,4})+/y;
const PLAIN_TEXT = /[^\\"]+/y;

type Mode = "(" | "[" | "{" | "interp" | "string";

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const modes: Mode[] = [];
  let at = 0;
  const push = (type: TokenType, end: number, extra: Partial<Token> = {}): void => {
    tokens.push({ type, text: source.slice(at, end), start: at, end, ...extra });
    at = end;
  };
  const match = (pattern: RegExp): number => {
    pattern.lastIndex = at;
    return pattern.test(source) ? pattern.lastIndex : -1;
  };

  while (at < source.length) {
    if (modes[modes.length - 1] === "string") {
      if (source.startsWith("\\(", at)) {
        modes.push("interp");
        push("interp-start", at + 2);
      } else if (source.charAt(at) === '"') {
        modes.pop();
        push("string-end", at + 1);
      } else {
        const escapes = match(ESCAPES);
        if (escapes !== -1) {
          const run = source.slice(at, escapes);
          const decoded = decodeEscapes(new TextEncoder().encode(run));
          if (typeof decoded === "string") push("string-text", escapes, { value: decoded });
          else push("string-text", escapes, { value: "", error: escapeError(run, decoded.error) });
          continue;
        }
        const plain = match(PLAIN_TEXT);
        if (plain !== -1) push("string-text", plain, { value: source.slice(at, plain) });
        else push("invalid", at + 1);
      }
      continue;
    }

    const char = source.charAt(at);
    if (char === "#") {
      at = skipComment(source, at);
      continue;
    }
    const space = match(WHITESPACE);
    if (space !== -1) {
      at = space;
      continue;
    }
    if (source.startsWith("$__loc__", at) && !/[a-zA-Z_0-9:]/.test(source.charAt(at + 8))) {
      push("loc", at + 8);
      continue;
    }
    const number = match(NUMBER);
    const field = char === "." ? matchAt(NAME, source, at + 1) : -1;
    if (number !== -1 && number >= field) {
      push("number", number, { value: parseLiteral(source.slice(at, number)) ?? Number.NaN });
      continue;
    }
    if (field !== -1) {
      push("field", field);
      continue;
    }
    if (char === "$") {
      const name = matchAt(QUALIFIED, source, at + 1);
      if (name !== -1) {
        push("binding", name);
        continue;
      }
    }
    if (char === "@") {
      const name = matchAt(/[a-zA-Z0-9_]+/y, source, at + 1);
      if (name !== -1) {
        push("format", name);
        continue;
      }
    }
    const word = match(QUALIFIED);
    if (word !== -1) {
      const text = source.slice(at, word);
      push(KEYWORDS.has(text) ? "keyword" : "ident", word);
      continue;
    }
    if (char === '"') {
      modes.push("string");
      push("string-start", at + 1);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      modes.push(char);
      push("punct", at + 1);
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      const top = modes[modes.length - 1];
      const opener = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (top === opener) {
        modes.pop();
        push("punct", at + 1);
      } else if (top === "interp" && char === ")") {
        modes.pop();
        push("interp-end", at + 1);
      } else push("invalid", at + 1);
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, at));
    if (operator !== undefined) {
      push("punct", at + operator.length);
      continue;
    }
    push(SINGLE.has(char) ? "punct" : "invalid", at + 1);
  }
  const last = tokens[tokens.length - 1];
  tokens.push({
    type: "eof",
    text: "",
    start: last?.start ?? 0,
    end: last?.end ?? 0,
  });
  return tokens;
}

function matchAt(pattern: RegExp, source: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.test(source) ? pattern.lastIndex : -1;
}

/** A comment runs to the end of the line; `\` before a newline continues it. */
function skipComment(source: string, at: number): number {
  let index = at + 1;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === "\\" && (source.charAt(index + 1) === "\\" || source.charAt(index + 1) === "\n")) {
      index += 2;
      continue;
    }
    if (char === "\\" && source.startsWith("\r\n", index + 1)) {
      index += 3;
      continue;
    }
    if (char === "\n") return index + 1;
    index++;
  }
  return index;
}

/**
 * jv_parse's message for the escape run wrapped in quotes, as jq reports it.
 * The parser judges escapes at the closing quote, so the column is its byte.
 */
function escapeError(run: string, message: string): string {
  const column = new TextEncoder().encode(run).length + 2;
  return `${message} at line 1, column ${column} (while parsing '"${run}"')`;
}
