// How deep source may nest. Parsing, planning, and execution each recurse
// once per level of `( … )`, `{ …; }`, `if`, `for`, `$( … )`, backquotes, and
// `${NAME:-word}` words, and a Worker's stack is small, so the nesting that
// reaches them is bounded here, with a refusal naming the limit.
//
// The word scanner parses a substitution while its word is read, before the
// commands around it are parsed, so no single counter sees both. Each parser
// bounds what it can see, and `checkNesting` walks the finished script with an
// explicit stack to bound the combination.

import { type Command, type Script, ShellSyntaxError, type Word, type WordPart } from "./ast.js";

export const NESTING_MAX = 64;

/** The parser, reached from the word scanner without an import cycle. */
export interface Nest {
  /** Enclosing levels at the current position. */
  readonly depth: number;
  /** One level deeper; refuses past `NESTING_MAX`. */
  enter(offset: number): Nest;
  /** Parses the list after `$(` at `start`; `end` is past its closing `)`. */
  substitution(source: string, start: number): { readonly body: Script; readonly end: number };
  /** Parses the unescaped text of a backquoted command. */
  backquoted(text: string): Script;
}

export function tooDeep(offset: number): ShellSyntaxError {
  return new ShellSyntaxError(
    "nesting",
    `commands and expansions nested deeper than ${NESTING_MAX} levels are not supported`,
    offset,
  );
}

type Node =
  | { readonly kind: "script"; readonly script: Script }
  | { readonly kind: "command"; readonly command: Command }
  | { readonly kind: "parts"; readonly parts: readonly WordPart[] };

/** Refuses a script whose compound commands and expansions nest past the limit. */
export function checkNesting(script: Script): void {
  // `offset` is where the outermost expansion on the path starts; only the
  // script's own words have offsets into its source. Null outside expansions.
  const stack: Array<{
    readonly node: Node;
    readonly depth: number;
    readonly offset: number | null;
  }> = [{ node: { kind: "script", script }, depth: 0, offset: null }];
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const { node, depth, offset } = entry;
    if (depth > NESTING_MAX) throw tooDeep(offset ?? 0);
    const push = (next: Node, deeper: boolean, at = offset): void => {
      stack.push({ node: next, depth: deeper ? depth + 1 : depth, offset: at });
    };
    const pushWords = (words: readonly Word[], deeper: boolean): void => {
      for (const word of words) push({ kind: "parts", parts: word.parts }, deeper);
    };

    if (node.kind === "script") {
      for (const statement of node.script.statements) {
        for (const command of statement.pipeline.commands)
          push({ kind: "command", command }, false);
      }
      continue;
    }
    if (node.kind === "parts") {
      for (const part of node.parts) {
        if (part.kind === "CommandSubstitution") {
          push({ kind: "script", script: part.body }, true, offset ?? part.offset);
        } else if (part.kind === "ParameterOperation") {
          push({ kind: "parts", parts: part.word }, true, offset ?? part.offset);
        }
      }
      continue;
    }

    const command = node.command;
    for (const redirection of command.redirections) {
      if (redirection.op === "<<") pushWords([redirection.body], false);
      else if (redirection.op !== ">&") pushWords([redirection.target], false);
    }
    const body = (statements: Script["statements"]): void => {
      push({ kind: "script", script: { kind: "Script", statements } }, true);
    };
    switch (command.kind) {
      case "SimpleCommand":
        pushWords(command.words, false);
        break;
      case "Subshell":
      case "Group":
        body(command.body);
        break;
      case "If":
        for (const clause of command.clauses) {
          body(clause.condition);
          body(clause.body);
        }
        if (command.otherwise !== null) body(command.otherwise);
        break;
      case "For":
        pushWords(command.words, false);
        body(command.body);
        break;
    }
  }
}
