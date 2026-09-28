// Simple commands and the redirections every command, simple or compound,
// may carry.

import {
  hasExpansion,
  type Redirection,
  ShellSyntaxError,
  type SimpleCommand,
  type Word,
  wordText,
} from "./ast.js";
import type { TokenCursor } from "./cursor.js";
import type { Operator } from "./lexer.js";

/** Words and redirections in any order, up to an operator that ends the command. */
export function parseSimpleCommand(cursor: TokenCursor): SimpleCommand {
  const words: Word[] = [];
  const redirections: Redirection[] = [];
  const start = cursor.offset();

  for (;;) {
    const token = cursor.peek();
    if (token?.type === "word") {
      words.push(token.word);
      cursor.advance();
      continue;
    }
    const redirection = parseRedirection(cursor);
    if (redirection === null) break; // `|`, `&&`, `||`, `;`, a parenthesis, and a newline end it.
    redirections.push(...redirection);
  }

  if (words[0] === undefined) {
    // Bash names the token that stands where the command should be.
    const unexpected = cursor.unexpected();
    throw new ShellSyntaxError("command", unexpected.message, unexpected.offset);
  }
  if (cursor.peekOperator() === "(") {
    if (words.length === 1) {
      throw new ShellSyntaxError(
        "function definition",
        "function definition is not supported",
        start,
      );
    }
    throw cursor.unexpected();
  }
  return { kind: "SimpleCommand", words, redirections, line: cursor.lineAt(start) };
}

/** The redirection at the cursor, or null when the next token starts none. */
export function parseRedirection(cursor: TokenCursor): Redirection[] | null {
  const token = cursor.peek();
  if (token?.type === "fd") {
    cursor.advance();
    return redirectionAfterDescriptor(cursor, token.value, token.offset);
  }
  if (token?.type === "op" && isRedirectionOperator(token.value)) {
    // No explicit fd: the `<` family reads stdin, everything else writes stdout.
    return redirectionAfterDescriptor(cursor, token.value.startsWith("<") ? 0 : 1, token.offset);
  }
  return null;
}

/**
 * One redirection, or two for `&>file`, `&>>file`, and `>&file` or `1>&file`, which Bash
 * defines as `>file 2>&1` and `>>file 2>&1`.
 */
function redirectionAfterDescriptor(
  cursor: TokenCursor,
  fd: number,
  offset: number,
): Redirection[] {
  const operator = cursor.peek();
  if (operator?.type !== "op") {
    throw new ShellSyntaxError("redirection", "expected a redirection operator", offset);
  }
  cursor.advance();

  if (operator.value === "&>" || operator.value === "&>>") {
    const { target, spelling } = redirectionTarget(cursor, offset);
    return [
      { kind: "Redirection", fd: 1, op: operator.value === "&>" ? ">" : ">>", target, spelling },
      { kind: "Redirection", fd: 2, op: ">&", targetFd: 1 },
    ];
  }

  if (operator.value === ">&") {
    const target = cursor.peek();
    if (target?.type !== "word") {
      throw new ShellSyntaxError("redirection", "expected a descriptor after >&", offset);
    }
    if (fd === 1 && !/^[0-9]+$/.test(wordText(target.word)) && isFileTarget(target.word)) {
      cursor.advance();
      return [
        {
          kind: "Redirection",
          fd: 1,
          op: ">",
          target: target.word,
          spelling: cursor.spelling(target),
        },
        { kind: "Redirection", fd: 2, op: ">&", targetFd: 1 },
      ];
    }
    if (hasExpansion(target.word)) {
      // The expansion would decide between a descriptor and a file.
      throw new ShellSyntaxError(
        "parameter expansion",
        "parameters in redirection targets of `>&` are not supported",
        target.offset,
      );
    }
    const text = wordText(target.word);
    if (!/^[0-9]+$/.test(text)) {
      throw new ShellSyntaxError("redirection", `\`>&${text}\` is not a descriptor`, offset);
    }
    cursor.advance();
    return [{ kind: "Redirection", fd, op: ">&", targetFd: Number(text) }];
  }

  if (operator.value === "<<" || operator.value === "<<-") {
    const body = cursor.peek();
    if (body?.type !== "hereDocument") {
      throw new ShellSyntaxError("here-document", "expected a here-document body", offset);
    }
    cursor.advance();
    return [{ kind: "Redirection", fd, op: "<<", body: body.body }];
  }

  if (operator.value === "<<<") {
    const target = cursor.peek();
    if (target?.type !== "word") {
      throw new ShellSyntaxError("redirection", "expected a word after <<<", offset);
    }
    cursor.advance();
    return [{ kind: "Redirection", fd, op: "<<<", target: target.word }];
  }

  if (operator.value !== ">" && operator.value !== ">>" && operator.value !== "<") {
    throw new ShellSyntaxError("redirection", "expected a redirection operator", offset);
  }

  const { target, spelling } = redirectionTarget(cursor, offset);
  return [{ kind: "Redirection", fd, op: operator.value, target, spelling }];
}

function redirectionTarget(
  cursor: TokenCursor,
  offset: number,
): { readonly target: Word; readonly spelling: string } {
  const target = cursor.peek();
  if (target?.type !== "word") {
    throw new ShellSyntaxError("redirection", "expected a target after the operator", offset);
  }
  cursor.advance();
  return { target: target.word, spelling: cursor.spelling(target) };
}

/** `>&-` closes and `>&$FD` may name a descriptor; neither is a file. */
function isFileTarget(word: Word): boolean {
  return wordText(word) !== "-" && !hasExpansion(word);
}

function isRedirectionOperator(value: Operator): boolean {
  return (
    value !== "|" &&
    value !== "||" &&
    value !== "&&" &&
    value !== ";" &&
    value !== "(" &&
    value !== ")"
  );
}
