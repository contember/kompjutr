// Words and operators. Quote-aware, because every operator in the grammar
// also appears inside a quoted grep pattern: `grep -E "a|b"` is one word,
// not a pipeline, and getting that wrong silently truncates the pattern.
//
// This is also where an unsupported construct is caught. It is caught here
// rather than in the parser because the giveaway is lexical — `$((`, `<(`,
// `[[` — and a lexer that swallowed them would hand the parser a word that
// looks ordinary.
//
// A command substitution is tokenized by the same loop, stopping at the `)`
// that closes it; words themselves are read in `word.ts`.
//
// A newline is a token, not whitespace: it ends a statement exactly as `;`
// does, and a here-document body starts after it.
//
// Indexing goes through `charAt`, which returns "" past the end, so the
// scanners need no bounds cast and no non-null assertion.

import { ShellSyntaxError, type Word } from "./ast.js";
import {
  type PendingHereDocument,
  readHereDocumentBodies,
  unterminatedHereDocument,
} from "./here-document.js";
import type { Nest } from "./nesting.js";
import { type Operator, readOperator } from "./operators.js";
import { readWord } from "./word.js";

export type { Operator } from "./operators.js";

export type Token =
  /** `end` is the offset past the word, so the typed spelling is `source.slice(offset, end)`. */
  | { readonly type: "word"; readonly word: Word; readonly offset: number; readonly end: number }
  | { readonly type: "op"; readonly value: Operator; readonly offset: number }
  /** A bare `2` immediately before `>` or `<`, never separated by space. */
  | { readonly type: "fd"; readonly value: number; readonly offset: number }
  | { readonly type: "newline"; readonly offset: number }
  /** Follows its `<<` operator; the body is read after the line ends. */
  | { readonly type: "hereDocument"; readonly body: Word; readonly offset: number };

const BLANK = new Set([" ", "\t", "\r"]);

/**
 * Lexical giveaways for constructs §2 of the plan rules out. Each maps to
 * the name the error reports, so an agent is told what it did rather than
 * being handed a column number.
 */
const REJECTED: ReadonlyArray<{ prefix: string; construct: string }> = [
  { prefix: "$((", construct: "arithmetic expansion" },
  { prefix: "((", construct: "arithmetic command" },
  { prefix: "<(", construct: "process substitution" },
  { prefix: ">(", construct: "process substitution" },
  { prefix: "[[", construct: "conditional expression" },
];

const DIGIT = /[0-9]/;

function reject(construct: string, at: number): never {
  throw new ShellSyntaxError(construct, `${construct} is not supported`, at);
}

export function tokenize(source: string, nest: Nest): Token[] {
  return scan(source, 0, nest, false).tokens;
}

/** The tokens of a `$( … )` body starting at `start`; `end` is past the closing `)`. */
export function tokenizeSubstitution(
  source: string,
  start: number,
  nest: Nest,
): { readonly tokens: Token[]; readonly end: number } {
  return scan(source, start, nest, true);
}

function scan(
  source: string,
  start: number,
  nest: Nest,
  substitution: boolean,
): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  const pending: PendingHereDocument[] = [];
  let parentheses = 0;
  let index = start;

  while (index < source.length) {
    const char = source.charAt(index);

    if (BLANK.has(char)) {
      index++;
      continue;
    }

    if (char === "\\" && source.charAt(index + 1) === "\n") {
      index += 2;
      continue;
    }

    if (char === "\n") {
      tokens.push({ type: "newline", offset: index });
      index = readHereDocumentBodies(source, index + 1, pending, tokens, nest);
      pending.length = 0;
      continue;
    }

    // The scanner only stops here at the start of a word, which is exactly
    // where `#` opens a comment; `a#b` is consumed whole by `readWord`.
    if (char === "#") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline;
      continue;
    }

    for (const { prefix, construct } of REJECTED) {
      if (source.startsWith(prefix, index)) reject(construct, index);
    }

    const operator = readOperator(source, index);
    if (operator !== null) {
      if (operator.value === "&") reject("background execution", index);
      if (operator.value === "(") parentheses++;
      if (operator.value === ")") {
        if (substitution && parentheses === 0) {
          const unterminated = pending[0];
          if (unterminated !== undefined) {
            throw new ShellSyntaxError(
              "here-document",
              "a here-document must end inside its command substitution",
              unterminated.offset,
            );
          }
          return { tokens, end: operator.end };
        }
        parentheses--;
      }
      tokens.push({ type: "op", value: operator.value, offset: index });
      index = operator.end;
      if (operator.value === "<<" || operator.value === "<<-") {
        index = readHereDocumentDelimiter(
          source,
          index,
          operator.value === "<<-",
          pending,
          tokens,
          nest,
        );
      }
      continue;
    }

    const fd = readFileDescriptor(source, index);
    if (fd !== null) {
      tokens.push({ type: "fd", value: fd.value, offset: index });
      index = fd.end;
      continue;
    }

    const word = readWord(source, index, nest);
    if (word.parts.length === 0) {
      throw new ShellSyntaxError("word", "empty word", index);
    }
    tokens.push({
      type: "word",
      word: { kind: "Word", parts: word.parts },
      offset: index,
      end: word.end,
    });
    index = word.end;
  }

  if (substitution) {
    throw new ShellSyntaxError(
      "command substitution",
      "unterminated command substitution: no closing `)`",
      start,
    );
  }
  const unterminated = pending[0];
  if (unterminated !== undefined) throw unterminatedHereDocument(unterminated);
  return { tokens, end: index };
}

/**
 * Reads the delimiter word after `<<` and reserves the token slot the body
 * fills once the line ends. Any quoting in the delimiter makes the body
 * literal, as in Bash.
 */
function readHereDocumentDelimiter(
  source: string,
  start: number,
  stripTabs: boolean,
  pending: PendingHereDocument[],
  tokens: Token[],
  nest: Nest,
): number {
  let index = start;
  while (BLANK.has(source.charAt(index))) index++;
  const word = readWord(source, index, nest);
  if (word.parts.length === 0) {
    throw new ShellSyntaxError("here-document", "expected a here-document delimiter", start);
  }
  let delimiter = "";
  let quoted = false;
  for (const part of word.parts) {
    if (
      part.kind === "Parameter" ||
      part.kind === "ParameterLength" ||
      part.kind === "ParameterOperation" ||
      part.kind === "CommandSubstitution"
    ) {
      throw new ShellSyntaxError(
        "here-document",
        "expansions in here-document delimiters are not supported",
        index,
      );
    }
    quoted ||= part.kind !== "Literal" && part.kind !== "Glob";
    delimiter += part.value;
  }
  pending.push({ tokenIndex: tokens.length, delimiter, quoted, stripTabs, offset: index });
  tokens.push({ type: "hereDocument", body: { kind: "Word", parts: [] }, offset: index });
  return word.end;
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
