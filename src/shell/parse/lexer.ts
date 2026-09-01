// Words and operators. Quote-aware, because every operator in the grammar
// also appears inside a quoted grep pattern: `grep -E "a|b"` is one word,
// not a pipeline, and getting that wrong silently truncates the pattern.
//
// This is also where an unsupported construct is caught. It is caught here
// rather than in the parser because the giveaway is lexical — `$(`, `<(`,
// `<<` — and a lexer that swallowed them would hand the parser a word that
// looks ordinary.
//
// Indexing goes through `charAt`, which returns "" past the end, so the
// scanners need no bounds cast and no non-null assertion.

import { ShellSyntaxError, type Word, type WordPart } from "./ast.js";

export type Operator = "|" | "||" | "&&" | ";" | ">" | ">>" | "<" | ">&";

export type Token =
  | { readonly type: "word"; readonly word: Word; readonly offset: number }
  | { readonly type: "op"; readonly value: Operator; readonly offset: number }
  /** A bare `2` immediately before `>` or `<`, never separated by space. */
  | { readonly type: "fd"; readonly value: number; readonly offset: number };

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/**
 * Lexical giveaways for constructs §2 of the plan rules out. Each maps to
 * the name the error reports, so an agent is told what it did rather than
 * being handed a column number.
 */
const REJECTED: ReadonlyArray<{ prefix: string; construct: string }> = [
  { prefix: "$((", construct: "arithmetic expansion" },
  { prefix: "$(", construct: "command substitution" },
  { prefix: "`", construct: "command substitution" },
  { prefix: "<(", construct: "process substitution" },
  { prefix: ">(", construct: "process substitution" },
  { prefix: "<<", construct: "here-document" },
  { prefix: "[[", construct: "conditional expression" },
];

/** Longest first, so `>>` wins over `>` and `||` over `|`. */
const OPERATORS: ReadonlyArray<Operator | "&"> = [">>", ">&", "&&", "||", "|", ";", ">", "<", "&"];

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_CONTINUE = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function reject(construct: string, at: number): never {
  throw new ShellSyntaxError(construct, `${construct} is not supported`, at);
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source.charAt(index);

    if (WHITESPACE.has(char)) {
      index++;
      continue;
    }

    // A `#` only opens a comment at the start of a word, so `a#b` is a word.
    if (char === "#" && (index === 0 || WHITESPACE.has(source.charAt(index - 1)))) {
      break;
    }

    for (const { prefix, construct } of REJECTED) {
      if (source.startsWith(prefix, index)) reject(construct, index);
    }

    if (char === "(" || char === ")") reject("subshell", index);
    if (char === "{" || char === "}") reject("command group", index);

    const operator = readOperator(source, index);
    if (operator !== null) {
      if (operator.value === "&") reject("background execution", index);
      tokens.push({ type: "op", value: operator.value, offset: index });
      index = operator.end;
      continue;
    }

    const fd = readFileDescriptor(source, index);
    if (fd !== null) {
      tokens.push({ type: "fd", value: fd.value, offset: index });
      index = fd.end;
      continue;
    }

    const word = readWord(source, index);
    if (word.parts.length === 0) {
      throw new ShellSyntaxError("word", "empty word", index);
    }
    tokens.push({ type: "word", word: { kind: "Word", parts: word.parts }, offset: index });
    index = word.end;
  }

  return tokens;
}

function readOperator(
  source: string,
  index: number,
): { value: Operator | "&"; end: number } | null {
  for (const candidate of OPERATORS) {
    if (source.startsWith(candidate, index)) {
      return { value: candidate, end: index + candidate.length };
    }
  }
  return null;
}

/**
 * `2>` and `2>&1`. Only digits immediately followed by a redirection
 * operator count — `2 > x` redirects stdout and passes `2` as an argument,
 * exactly as bash does.
 */
function readFileDescriptor(source: string, index: number): { value: number; end: number } | null {
  let end = index;
  while (end < source.length && DIGIT.test(source.charAt(end))) end++;
  if (end === index) return null;
  const next = source.charAt(end);
  if (next !== ">" && next !== "<") return null;
  return { value: Number(source.slice(index, end)), end };
}

interface WordScan {
  parts: WordPart[];
  end: number;
}

function readWord(source: string, start: number): WordScan {
  const parts: WordPart[] = [];
  let literal = "";
  let index = start;

  const flushLiteral = (): void => {
    if (literal !== "") {
      parts.push({ kind: "Literal", value: literal });
      literal = "";
    }
  };

  while (index < source.length) {
    const char = source.charAt(index);

    if (WHITESPACE.has(char)) break;
    if (readOperator(source, index) !== null) break;

    if (char === "\\") {
      if (index + 1 >= source.length) {
        throw new ShellSyntaxError("escape", "trailing backslash", index);
      }
      flushLiteral();
      parts.push({ kind: "Escaped", value: source.charAt(index + 1) });
      index += 2;
      continue;
    }

    if (char === "'") {
      const close = source.indexOf("'", index + 1);
      if (close === -1) throw new ShellSyntaxError("quote", "unterminated single quote", index);
      flushLiteral();
      parts.push({ kind: "SingleQuoted", value: source.slice(index + 1, close) });
      index = close + 1;
      continue;
    }

    if (char === '"') {
      const scan = readDoubleQuoted(source, index);
      flushLiteral();
      parts.push(...scan.parts);
      index = scan.end;
      continue;
    }

    if (char === "$") {
      const parameter = readParameter(source, index, false);
      if (parameter !== null) {
        flushLiteral();
        parts.push(parameter.part);
        index = parameter.end;
        continue;
      }
    }

    // Unquoted glob metacharacters. A `[` only opens a class if it closes.
    if (char === "*" || char === "?") {
      flushLiteral();
      parts.push({ kind: "Glob", value: char });
      index++;
      continue;
    }
    if (char === "[") {
      const close = findClassEnd(source, index);
      if (close !== -1) {
        flushLiteral();
        parts.push({ kind: "Glob", value: source.slice(index, close + 1) });
        index = close + 1;
        continue;
      }
    }

    if (char === "`") reject("command substitution", index);

    literal += char;
    index++;
  }

  flushLiteral();
  return { parts, end: index };
}

function readDoubleQuoted(source: string, start: number): WordScan {
  const parts: WordPart[] = [];
  let value = "";
  let index = start + 1;
  const flushValue = (keepEmpty = false): void => {
    if (value !== "" || keepEmpty) {
      parts.push({ kind: "DoubleQuoted", value });
      value = "";
    }
  };
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === '"') {
      flushValue(parts.length === 0);
      return { parts, end: index + 1 };
    }
    if (char === "\\") {
      if (index + 1 >= source.length) break;
      const escaped = source.charAt(index + 1);
      // Inside double quotes bash only honours these four; everything else
      // keeps its backslash, which is what `grep "a\.b"` depends on.
      value += '"\\$`'.includes(escaped) ? escaped : `\\${escaped}`;
      index += 2;
      continue;
    }
    if (char === "$") {
      const parameter = readParameter(source, index, true);
      if (parameter !== null) {
        flushValue();
        parts.push(parameter.part);
        index = parameter.end;
        continue;
      }
    }
    if (char === "`") reject("command substitution", index);
    value += char;
    index++;
  }
  throw new ShellSyntaxError("quote", "unterminated double quote", start);
}

function readParameter(
  source: string,
  start: number,
  quoted: boolean,
): { readonly part: WordPart; readonly end: number } | null {
  const next = source.charAt(start + 1);
  if (DIGIT.test(next)) {
    throw new ShellSyntaxError(
      "parameter expansion",
      `parameter expansion for positional parameter $${next} is not supported`,
      start,
    );
  }
  if (next !== "" && "*@#?-$!".includes(next)) {
    throw new ShellSyntaxError(
      "parameter expansion",
      `parameter expansion for special parameter $${next} is not supported`,
      start,
    );
  }
  if (next === "{") return readBracedParameter(source, start, quoted);
  if (!IDENTIFIER_START.test(next)) return null;

  let end = start + 2;
  while (IDENTIFIER_CONTINUE.test(source.charAt(end))) end++;
  return {
    part: { kind: "Parameter", name: source.slice(start + 1, end), quoted },
    end,
  };
}

function readBracedParameter(
  source: string,
  start: number,
  quoted: boolean,
): { readonly part: WordPart; readonly end: number } {
  const close = source.indexOf("}", start + 2);
  if (close === -1) {
    throw new ShellSyntaxError("parameter expansion", "unterminated parameter expansion", start);
  }
  const body = source.slice(start + 2, close);
  if (!IDENTIFIER_START.test(body.charAt(0))) {
    throw new ShellSyntaxError(
      "parameter expansion",
      `parameter \${${body}} is not supported`,
      start,
    );
  }
  let nameEnd = 1;
  while (nameEnd < body.length && IDENTIFIER_CONTINUE.test(body.charAt(nameEnd))) nameEnd++;
  if (nameEnd !== body.length) {
    throw new ShellSyntaxError(
      "parameter expansion operator",
      `parameter expansion operator in \${${body}} is not supported`,
      start,
    );
  }
  return {
    part: { kind: "Parameter", name: body, quoted },
    end: close + 1,
  };
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
    if (char === "/" || WHITESPACE.has(char)) return -1;
    index++;
  }
  return -1;
}
