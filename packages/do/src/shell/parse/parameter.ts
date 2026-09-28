// `$NAME` and `${NAME}`, shared by words and unquoted here-document bodies.
// Every other `$` form is rejected by name rather than read as literal text.

import { ShellSyntaxError, type WordPart } from "./ast.js";

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_CONTINUE = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

/** A parameter part starting at `$`, or null when `$` is literal text. */
export function readParameter(
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
