// Here-document bodies. A body starts on the line after its `<<` operator and
// runs to a line equal to the delimiter; several on one line are read in
// order. An unquoted delimiter admits `$NAME`, `${NAME}`, and the backslash
// escapes Bash honours there; a quoted one keeps the body byte-for-byte.

import { ShellSyntaxError, type WordPart } from "./ast.js";
import type { Token } from "./lexer.js";
import { readParameter } from "./parameter.js";

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
          : expandableParts(body.text, body.start),
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

function expandableParts(body: string, offset: number): WordPart[] {
  const parts: WordPart[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal === "") return;
    parts.push({ kind: "DoubleQuoted", value: literal });
    literal = "";
  };

  let index = 0;
  while (index < body.length) {
    const char = body.charAt(index);
    if (char === "\\") {
      const escaped = body.charAt(index + 1);
      if (escaped === "\n") {
        index += 2;
        continue;
      }
      if (escaped !== "" && "$`\\".includes(escaped)) {
        literal += escaped;
        index += 2;
        continue;
      }
    }
    if (char === "`" || body.startsWith("$(", index)) {
      const construct = body.startsWith("$((", index)
        ? "arithmetic expansion"
        : "command substitution";
      throw new ShellSyntaxError(construct, `${construct} is not supported`, offset + index);
    }
    if (char === "$") {
      const parameter = readParameter(body, index, true);
      if (parameter !== null) {
        flush();
        parts.push(parameter.part);
        index = parameter.end;
        continue;
      }
    }
    literal += char;
    index++;
  }
  flush();
  return parts;
}
