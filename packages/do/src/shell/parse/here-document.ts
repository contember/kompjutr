// Here-document bodies. A body starts on the line after its `<<` operator and
// runs to a line equal to the delimiter; several on one line are read in
// order. An unquoted delimiter admits parameters, command substitutions, and
// the backslash escapes Bash honours there; a quoted one keeps the body
// byte-for-byte.

import { ShellSyntaxError } from "./ast.js";
import type { Token } from "./lexer.js";
import type { Nest } from "./nesting.js";
import { readQuoted } from "./word.js";

export interface PendingHereDocument {
  readonly tokenIndex: number;
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
  readonly offset: number;
}

/** Fills each pending body token and returns the index after the last body. */
export function readHereDocumentBodies(
  source: string,
  start: number,
  pending: readonly PendingHereDocument[],
  tokens: Token[],
  nest: Nest,
): number {
  let index = start;
  for (const document of pending) {
    const body = readBody(source, index, document);
    tokens[document.tokenIndex] = {
      type: "hereDocument",
      body: {
        kind: "Word",
        parts: document.quoted
          ? [{ kind: "SingleQuoted", value: body.text }]
          : readQuoted(body.text, 0, nest, "heredoc").parts,
      },
      offset: document.offset,
    };
    index = body.end;
  }
  return index;
}

function readBody(
  source: string,
  start: number,
  document: PendingHereDocument,
): { text: string; start: number; end: number } {
  let text = "";
  let index = start;
  while (index < source.length) {
    const newline = source.indexOf("\n", index);
    const lineEnd = newline === -1 ? source.length : newline;
    const raw = source.slice(index, lineEnd);
    const line = document.stripTabs ? raw.replace(/^\t+/, "") : raw;
    const next = newline === -1 ? source.length : newline + 1;
    if (line === document.delimiter) return { text, start, end: next };
    text += newline === -1 ? line : `${line}\n`;
    index = next;
  }
  throw unterminatedHereDocument(document);
}

export function unterminatedHereDocument(document: PendingHereDocument): ShellSyntaxError {
  return new ShellSyntaxError(
    "here-document",
    `here-document delimited by end of input (wanted '${document.delimiter}')`,
    document.offset,
  );
}
