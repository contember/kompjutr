// Word scanning: quotes, escapes, globs, parameters, and command
// substitutions. Every scanner returns ordered parts, because only some parts
// of a word may split, match paths, or expand a tilde.
//
// `$( … )`, backquotes, and `${NAME:-word}` words recurse through `Nest`,
// which bounds the depth and reaches the parser without an import cycle. Every
// `$` form this shell does not implement is rejected by name rather than read
// as literal text.
//
// Indexing goes through `charAt`, which returns "" past the end, so the
// scanners need no bounds cast and no non-null assertion.

import { type ParameterOperator, ShellSyntaxError, type WordPart } from "./ast.js";
import type { Nest } from "./nesting.js";
import { readOperator } from "./operators.js";

export interface WordScan {
  readonly parts: WordPart[];
  readonly end: number;
}

/**
 * Where quoted text is read, which decides what ends it and which escapes
 * lose their backslash: a double-quoted string, the word of a double-quoted
 * `${NAME:-word}`, or an unquoted here-document body.
 */
type QuotedDialect = "double" | "operand" | "heredoc";

const ESCAPES: Readonly<Record<QuotedDialect, string>> = {
  double: '"\\$`',
  operand: '"\\$`}',
  heredoc: "\\$`",
};

const WORD_END = new Set([" ", "\t", "\r", "\n"]);
const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_CONTINUE = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const OPERATORS: ReadonlyArray<ParameterOperator> = [":-", ":+", ":=", ":?", "-", "+", "=", "?"];

function reject(construct: string, at: number): never {
  throw new ShellSyntaxError(construct, `${construct} is not supported`, at);
}

/**
 * An unquoted word up to a blank or an operator, or with `operand` the word of
 * an unquoted `${NAME:-word}` up to its `}`, where blanks and operators are
 * ordinary characters.
 */
export function readWord(source: string, start: number, nest: Nest, operand = false): WordScan {
  const parts: WordPart[] = [];
  let literal = "";
  let index = start;

  const flushLiteral = (): void => {
    if (literal !== "") {
      parts.push({ kind: "Literal", value: literal });
      literal = "";
    }
  };
  const push = (part: WordPart, end: number): void => {
    flushLiteral();
    parts.push(part);
    index = end;
  };

  while (index < source.length) {
    const char = source.charAt(index);

    if (operand) {
      if (char === "}") break;
    } else if (WORD_END.has(char) || readOperator(source, index) !== null) {
      break;
    }

    if (char === "\\" && source.charAt(index + 1) === "\n") {
      index += 2;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= source.length) {
        throw new ShellSyntaxError("escape", "trailing backslash", index);
      }
      push({ kind: "Escaped", value: source.charAt(index + 1) }, index + 2);
      continue;
    }

    if (char === "'") {
      const close = source.indexOf("'", index + 1);
      if (close === -1) throw new ShellSyntaxError("quote", "unterminated single quote", index);
      push({ kind: "SingleQuoted", value: source.slice(index + 1, close) }, close + 1);
      continue;
    }

    if (char === '"') {
      const scan = readQuoted(source, index + 1, nest, "double");
      flushLiteral();
      parts.push(...scan.parts);
      index = scan.end;
      continue;
    }

    if (char === "`") {
      const scan = readBackquote(source, index, nest, "unquoted");
      push(scan.part, scan.end);
      continue;
    }

    if (char === "$") {
      const expansion = readDollar(source, index, false, nest);
      if (expansion !== null) {
        if (
          !operand &&
          expansion.part.kind === "Parameter" &&
          source.charAt(index + 1) !== "{" &&
          source.charAt(expansion.end) === "{"
        ) {
          // Bash expands braces first, so `$X{a,b}` names `$Xa` and `$Xb`.
          reject("brace expansion after an unbraced parameter", expansion.end);
        }
        push(expansion.part, expansion.end);
        continue;
      }
    }

    // Unquoted glob metacharacters. A `[` only opens a class if it closes.
    if (char === "*" || char === "?") {
      push({ kind: "Glob", value: char }, index + 1);
      continue;
    }
    if (char === "[") {
      const close = findClassEnd(source, index);
      if (close !== -1) {
        push({ kind: "Glob", value: source.slice(index, close + 1) }, close + 1);
        continue;
      }
    }

    literal += char;
    index++;
  }

  flushLiteral();
  return { parts, end: index };
}

/**
 * Quoted text from `start`, just past its opening character. A `double`
 * string ends past its `"`, an `operand` at its `}` (not consumed), and a
 * `heredoc` body at the end of the source. Every part is quoted.
 */
export function readQuoted(
  source: string,
  start: number,
  nest: Nest,
  dialect: QuotedDialect,
): WordScan {
  const parts: WordPart[] = [];
  let value = "";
  let index = start;
  // Inside an operand, a nested `"…"` only protects a `}`; its text stays quoted.
  let nested = false;
  const flushValue = (keepEmpty = false): void => {
    if (value !== "" || keepEmpty) {
      parts.push({ kind: "DoubleQuoted", value });
      value = "";
    }
  };

  while (index < source.length) {
    const char = source.charAt(index);
    if (dialect === "double" && char === '"') {
      flushValue(parts.length === 0);
      return { parts, end: index + 1 };
    }
    if (dialect === "operand") {
      if (char === '"') {
        nested = !nested;
        index++;
        continue;
      }
      if (char === "}" && !nested) {
        flushValue();
        return { parts, end: index };
      }
      if (char === "'" && !nested) {
        // Bash pairs the quote to find the `}` but then keeps it as text.
        throw new ShellSyntaxError(
          "parameter expansion",
          "a single quote in the word of a double-quoted parameter expansion is not supported",
          index,
        );
      }
    }
    if (char === "\\") {
      const escaped = source.charAt(index + 1);
      if (escaped === "\n") {
        index += 2;
        continue;
      }
      if (escaped !== "" && ESCAPES[dialect].includes(escaped)) {
        value += escaped;
        index += 2;
        continue;
      }
      // Any other backslash is text, which is what `grep "a\.b"` depends on.
      value += char;
      index++;
      continue;
    }
    if (char === "`") {
      const scan = readBackquote(source, index, nest, dialect === "heredoc" ? "heredoc" : "double");
      flushValue();
      parts.push(scan.part);
      index = scan.end;
      continue;
    }
    if (char === "$") {
      const expansion = readDollar(source, index, true, nest);
      if (expansion !== null) {
        flushValue();
        parts.push(expansion.part);
        index = expansion.end;
        continue;
      }
    }
    value += char;
    index++;
  }

  if (dialect === "heredoc") {
    flushValue();
    return { parts, end: index };
  }
  if (dialect === "double") {
    throw new ShellSyntaxError("quote", "unterminated double quote", start - 1);
  }
  throw new ShellSyntaxError("parameter expansion", "unterminated parameter expansion", start);
}

/**
 * A backquoted command. Inside it a backslash keeps its meaning except before
 * `$`, `` ` ``, `\`, and, within double quotes, `"`; the text left is parsed
 * as a list.
 */
function readBackquote(
  source: string,
  start: number,
  nest: Nest,
  context: "unquoted" | "double" | "heredoc",
): { readonly part: WordPart; readonly end: number } {
  let text = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === "`") {
      const body = nest.enter(start).backquoted(text);
      return {
        part: { kind: "CommandSubstitution", body, quoted: context !== "unquoted" },
        end: index + 1,
      };
    }
    const next = source.charAt(index + 1);
    if (char === "\\" && ("$`\\".includes(next) || (context === "double" && next === '"'))) {
      text += next;
      index += 2;
      continue;
    }
    text += char;
    index++;
  }
  throw new ShellSyntaxError(
    "command substitution",
    "unterminated command substitution: no closing backquote",
    start,
  );
}

/** The expansion starting at `$`, or null when the `$` is literal text. */
export function readDollar(
  source: string,
  start: number,
  quoted: boolean,
  nest: Nest,
): { readonly part: WordPart; readonly end: number } | null {
  const next = source.charAt(start + 1);
  if (next === "(") {
    if (source.charAt(start + 2) === "(") reject("arithmetic expansion", start);
    const { body, end } = nest.enter(start).substitution(source, start + 2);
    return { part: { kind: "CommandSubstitution", body, quoted }, end };
  }
  if (!quoted && next === "'") reject("ANSI-C quoting ($'…')", start);
  if (!quoted && next === '"') reject('locale translation ($"…")', start);
  if (DIGIT.test(next)) {
    throw new ShellSyntaxError(
      "parameter expansion",
      `parameter expansion for positional parameter $${next} is not supported`,
      start,
    );
  }
  if (next === "?") {
    return { part: { kind: "Parameter", name: "?", quoted }, end: start + 2 };
  }
  if (next !== "" && "*@#-$!".includes(next)) {
    throw new ShellSyntaxError(
      "parameter expansion",
      `parameter expansion for special parameter $${next} is not supported`,
      start,
    );
  }
  if (next === "{") return readBraced(source, start, quoted, nest);
  const name = identifierAt(source, start + 1);
  if (name === null) return null;
  return { part: { kind: "Parameter", name, quoted }, end: start + 1 + name.length };
}

function readBraced(
  source: string,
  start: number,
  quoted: boolean,
  nest: Nest,
): { readonly part: WordPart; readonly end: number } {
  let index = start + 2;
  if (source.charAt(index) === "#") {
    const name = identifierAt(source, index + 1);
    if (name !== null && source.charAt(index + 1 + name.length) === "}") {
      return {
        part: { kind: "ParameterLength", name, quoted },
        end: index + name.length + 2,
      };
    }
    throw unsupported(source, start, "parameter expansion");
  }
  if (source.startsWith("?}", index)) {
    return { part: { kind: "Parameter", name: "?", quoted }, end: index + 2 };
  }
  const name = identifierAt(source, index);
  if (name === null) throw unsupported(source, start, "parameter expansion");
  index += name.length;
  if (source.charAt(index) === "}") {
    return { part: { kind: "Parameter", name, quoted }, end: index + 1 };
  }
  const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
  if (operator === undefined) throw unsupported(source, start, "parameter expansion operator");

  const inner = nest.enter(start);
  const wordStart = index + operator.length;
  const scan = quoted
    ? readQuoted(source, wordStart, inner, "operand")
    : readWord(source, wordStart, inner, true);
  if (source.charAt(scan.end) !== "}") {
    throw new ShellSyntaxError("parameter expansion", "unterminated parameter expansion", start);
  }
  return {
    part: { kind: "ParameterOperation", name, operator, word: scan.parts, quoted },
    end: scan.end + 1,
  };
}

function unsupported(source: string, start: number, construct: string): ShellSyntaxError {
  const close = source.indexOf("}", start + 2);
  if (close === -1) {
    return new ShellSyntaxError("parameter expansion", "unterminated parameter expansion", start);
  }
  const body = source.slice(start + 2, close);
  const message =
    construct === "parameter expansion operator"
      ? `parameter expansion operator in \${${body}} is not supported`
      : `parameter \${${body}} is not supported`;
  return new ShellSyntaxError(construct, message, start);
}

function identifierAt(source: string, start: number): string | null {
  if (!IDENTIFIER_START.test(source.charAt(start))) return null;
  let end = start + 1;
  while (IDENTIFIER_CONTINUE.test(source.charAt(end))) end++;
  return source.slice(start, end);
}

/** The end of a `[...]` class, or -1 when it never closes. */
function findClassEnd(source: string, open: number): number {
  let index = open + 1;
  if (source.charAt(index) === "!" || source.charAt(index) === "^") index++;
  if (source.charAt(index) === "]") index++; // A leading `]` is a literal member.
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === "]") return index;
    // A class never spans a path separator or a word boundary.
    if (char === "/" || WORD_END.has(char)) return -1;
    index++;
  }
  return -1;
}
