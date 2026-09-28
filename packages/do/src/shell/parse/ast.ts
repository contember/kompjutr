// The grammar, sized from evidence rather than from bash.
//
// 614 real agent command lines were parsed through a full bash grammar and
// the node kinds it emitted were counted: of ~80 kinds, 11 covered 613 of
// them. Those 11 are below, plus here-documents, which agents use to write
// files, word expansions (tilde, braces), and the compound commands whose
// execution is bounded: subshells, groups, `if`, and `for … in` (ADR-0027).
// Everything else — arithmetic, `case`, `while`, process substitution,
// functions, `[[ ]]` — is rejected by name rather than half-implemented,
// because a construct that
// parses and then means something slightly different is worse than one that
// does not parse at all. See docs/archive/plans/shell.md §1.2.

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
  | { readonly kind: "Parameter"; readonly name: string; readonly quoted: boolean }
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
    }
  | {
      readonly kind: "Redirection";
      readonly fd: number;
      /** A here-document; `<<-` tab stripping is already applied to the body. */
      readonly op: "<<";
      readonly body: Word;
    }
  | {
      readonly kind: "Redirection";
      readonly fd: number;
      /** A here-string: the word plus a trailing newline. */
      readonly op: "<<<";
      readonly target: Word;
    };

export interface SimpleCommand {
  readonly kind: "SimpleCommand";
  /** Never empty: a command with no words is a syntax error. */
  readonly words: readonly Word[];
  readonly redirections: readonly Redirection[];
  /** The one-based source line the command starts on. */
  readonly line: number;
}

/** Redirections after the closing word apply to the whole body. */
interface CompoundBase {
  readonly redirections: readonly Redirection[];
  /** The one-based source line of the opening word. */
  readonly line: number;
}

/** `( list )`: the body runs on a copy of the shell state. */
export interface Subshell extends CompoundBase {
  readonly kind: "Subshell";
  readonly body: readonly Statement[];
}

/** `{ list; }`: the body runs in the current shell. */
export interface Group extends CompoundBase {
  readonly kind: "Group";
  readonly body: readonly Statement[];
}

export interface IfClause {
  readonly condition: readonly Statement[];
  readonly body: readonly Statement[];
}

/** `if … then …` followed by any `elif` clauses, in order. */
export interface IfCommand extends CompoundBase {
  readonly kind: "If";
  readonly clauses: readonly IfClause[];
  readonly otherwise: readonly Statement[] | null;
}

/** `for NAME in WORDS; do …; done`. */
export interface ForCommand extends CompoundBase {
  readonly kind: "For";
  readonly name: string;
  readonly words: readonly Word[];
  readonly body: readonly Statement[];
}

export type CompoundCommand = Subshell | Group | IfCommand | ForCommand;

export type Command = SimpleCommand | CompoundCommand;

export interface Pipeline {
  readonly kind: "Pipeline";
  readonly commands: readonly Command[];
  /** `! pipeline` inverts the status. */
  readonly negated: boolean;
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
  for (const part of word.parts) {
    text += part.kind === "Parameter" ? `$${part.name}` : part.value;
  }
  return text;
}

/** True when any part can match more than one path. */
export function hasGlob(word: Word): boolean {
  return word.parts.some((part) => part.kind === "Glob");
}
