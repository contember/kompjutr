// The grammar, sized from evidence rather than from bash.
//
// 614 real agent command lines were parsed through a full bash grammar and
// the node kinds it emitted were counted: of ~80 kinds, 11 covered 613 of
// them. Those 11 are below. Everything else — arithmetic, `case`, here-docs,
// process substitution, brace expansion, functions, `[[ ]]` — is rejected by
// name in `lexer.ts` rather than half-implemented, because a construct that
// parses and then means something slightly different is worse than one that
// does not parse at all. See docs/plans/shell.md §1.2.

/**
 * A word is a sequence of parts, not a string: `"a b"*.ts` is one word made
 * of a quoted part and a glob, and only the second may match paths. Joining
 * them early would lose exactly the distinction the planner needs.
 */
export type WordPart =
  | { readonly kind: "Literal"; readonly value: string }
  | { readonly kind: "SingleQuoted"; readonly value: string }
  | { readonly kind: "DoubleQuoted"; readonly value: string }
  | { readonly kind: "Escaped"; readonly value: string }
  /** An unquoted `*`, `?` or `[...]`. Quoted ones are `Literal`. */
  | { readonly kind: "Glob"; readonly value: string };

export interface Word {
  readonly kind: "Word";
  readonly parts: readonly WordPart[];
}

export type RedirectionOp = ">" | ">>" | "<";

/**
 * `2>/dev/null` and `2>&1` are 145 of the 614 corpus lines — the single most
 * common piece of syntax after the pipe. Both are carried structurally so
 * the planner can turn them into flags instead of buffers.
 */
export type Redirection =
  | {
      readonly kind: "Redirection";
      readonly fd: number;
      readonly op: RedirectionOp;
      readonly target: Word;
    }
  | {
      readonly kind: "Redirection";
      readonly fd: number;
      readonly op: ">&";
      /** `2>&1` — duplicate this descriptor onto `fd`. */
      readonly targetFd: number;
    };

export interface SimpleCommand {
  readonly kind: "SimpleCommand";
  /** Never empty: a command with no words is a syntax error. */
  readonly words: readonly Word[];
  readonly redirections: readonly Redirection[];
}

export interface Pipeline {
  readonly kind: "Pipeline";
  readonly commands: readonly SimpleCommand[];
}

/** How a statement joins the one after it. `null` on the last. */
export type Connector = "&&" | "||" | ";";

export interface Statement {
  readonly kind: "Statement";
  readonly pipeline: Pipeline;
  readonly connector: Connector | null;
}

export interface Script {
  readonly kind: "Script";
  readonly statements: readonly Statement[];
}

/**
 * A construct we deliberately do not implement, or malformed input.
 *
 * `construct` names what was found so the caller can say "process
 * substitution is not supported here" rather than "syntax error at 17".
 */
export class ShellSyntaxError extends Error {
  readonly construct: string;
  readonly offset: number;

  constructor(construct: string, message: string, offset: number) {
    super(message);
    this.name = "ShellSyntaxError";
    this.construct = construct;
    this.offset = offset;
  }
}

/** Flatten a word to text. Only valid once globs are resolved or ignored. */
export function wordText(word: Word): string {
  let text = "";
  for (const part of word.parts) text += part.value;
  return text;
}

/** True when any part can match more than one path. */
export function hasGlob(word: Word): boolean {
  return word.parts.some((part) => part.kind === "Glob");
}
