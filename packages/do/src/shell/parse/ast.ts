// The grammar, sized from evidence rather than from bash.
//
// 614 real agent command lines were parsed through a full bash grammar and
// the node kinds it emitted were counted: of ~80 kinds, 11 covered 613 of
// them. Those 11 are below, plus here-documents, which agents use to write
// files, word expansions (tilde, braces, command substitution, the `${…}`
// default operators), and the compound commands whose execution is bounded:
// subshells, groups, `if`, and `for … in` (ADR-0027).
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
  /** `${#NAME}`. */
  | { readonly kind: "ParameterLength"; readonly name: string; readonly quoted: boolean }
  /**
   * `${NAME:-word}` and its siblings. `word` is read in the quote context of
   * the expansion: inside double quotes every part of it is quoted.
   */
  | {
      readonly kind: "ParameterOperation";
      readonly name: string;
      readonly operator: ParameterOperator;
      readonly word: readonly WordPart[];
      readonly quoted: boolean;
    }
  /** `$( … )` or a backquoted command, parsed when the word is read. */
  | { readonly kind: "CommandSubstitution"; readonly body: Script; readonly quoted: boolean }
  /** An unquoted `*`, `?` or `[...]`. Quoted ones are `Literal`. */
  | { readonly kind: "Glob"; readonly value: string };

/** A leading `:` also treats an empty value as unset. */
export type ParameterOperator = "-" | ":-" | "+" | ":+" | "=" | ":=" | "?" | ":?";

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
      /** The target as typed, which Bash names in an ambiguous-redirect diagnostic. */
      readonly spelling: string;
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
  for (const part of word.parts) text += partText(part);
  return text;
}

/** A part as text; an expansion is shown in its source shape, not expanded. */
export function partText(part: WordPart): string {
  switch (part.kind) {
    case "Parameter":
      return `$${part.name}`;
    case "ParameterLength":
      return `\${#${part.name}}`;
    case "ParameterOperation":
      return `\${${part.name}${part.operator}${part.word.map(partText).join("")}}`;
    case "CommandSubstitution":
      return "$(…)";
    default:
      return part.value;
  }
}

/** True when any part expands a parameter or runs a command. */
export function hasExpansion(word: Word): boolean {
  return word.parts.some(isExpansion);
}

export function isExpansion(part: WordPart): boolean {
  return (
    part.kind === "Parameter" ||
    part.kind === "ParameterLength" ||
    part.kind === "ParameterOperation" ||
    part.kind === "CommandSubstitution"
  );
}

/** True when any part can match more than one path. */
export function hasGlob(word: Word): boolean {
  return word.parts.some((part) => part.kind === "Glob");
}
