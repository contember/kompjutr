// What the executor runs. An AST says what was typed; a plan says what will
// be asked of the filesystem.
//
// Nothing here imports `src/fs/`: planning is pure, so every rewrite in
// `plan.ts` is testable without a database. Anything that needs the
// filesystem — expanding a glob, resolving a path — is *marked* here and
// performed by the executor.

import type { Connector, ParameterOperator } from "../parse/ast.js";

export type ArgumentPart =
  | { readonly kind: "literal"; readonly value: string; readonly quoted: boolean }
  | { readonly kind: "parameter"; readonly name: string; readonly quoted: boolean }
  /** `${#NAME}`. */
  | { readonly kind: "length"; readonly name: string; readonly quoted: boolean }
  /** `${NAME:-word}` and its siblings; `word` expands only when the operator selects it. */
  | {
      readonly kind: "conditional";
      readonly name: string;
      readonly operator: ParameterOperator;
      readonly word: readonly FlatPart[];
      readonly quoted: boolean;
    }
  /** `$( … )` or backquotes: the planned list, run by the executor in a subshell. */
  | { readonly kind: "substitution"; readonly body: Plan; readonly quoted: boolean }
  | { readonly kind: "glob"; readonly value: string }
  /**
   * `{a,b}`: one generated word per alternative, before any other expansion.
   * `value` is the unexpanded text, quote-removed; only the executor generates.
   */
  | {
      readonly kind: "brace";
      readonly value: string;
      readonly alternatives: readonly (readonly ArgumentPart[])[];
    }
  /** `{1..9..2}` or `{a..e}`; `value` is the unexpanded text. */
  | { readonly kind: "sequence"; readonly value: string; readonly sequence: BraceSequence };

/** A part of a word with no brace expression left: typed, or generated. */
export type FlatPart = Exclude<ArgumentPart, { readonly kind: "brace" | "sequence" }>;

/** A part as source-shaped text, for diagnostics; expansions stay unexpanded. */
export function partSpelling(part: ArgumentPart): string {
  switch (part.kind) {
    case "parameter":
      return `$${part.name}`;
    case "length":
      return `\${#${part.name}}`;
    case "conditional":
      return `\${${part.name}${part.operator}${part.word.map(partSpelling).join("")}}`;
    case "substitution":
      return "$(…)";
    default:
      return part.value;
  }
}

/**
 * A validated sequence expression. `step` is a positive magnitude; the
 * direction follows from `start` and `end`, as in Bash. Integers stay within
 * Bash's `intmax_t`, and `width` is the zero-padded width or 0.
 */
export type BraceSequence =
  | {
      readonly kind: "integer";
      readonly start: bigint;
      readonly end: bigint;
      readonly step: bigint;
      readonly width: number;
    }
  | {
      readonly kind: "character";
      readonly start: number;
      readonly end: number;
      readonly step: bigint;
    };

/**
 * One argument retained as ordered parts until its run environment is known.
 * The kind selects where a tilde prefix may start: an `assignment` is shaped
 * like `NAME=value` with no brace expansion and also expands after its `=`
 * and each `:`; a `here-string` also expands after each `:`. A `declaration`
 * is an `export NAME=value` operand: tilde rules of an assignment, and one
 * field with no splitting or pathname expansion.
 */
export interface Argument {
  readonly kind: "word" | "assignment" | "declaration" | "here-string";
  readonly parts: readonly ArgumentPart[];
}

/** `NAME=value` or `NAME+=value` before a command, or standing alone. */
export interface PlannedAssignment {
  readonly name: string;
  readonly append: boolean;
  /** The whole word, `NAME=` included, as an `assignment` argument. */
  readonly word: Argument;
}

/** One descriptor binding, retained in source order for left-to-right resolution. */
export type PlannedRedirection =
  | {
      readonly kind: "read";
      readonly fd: 0;
      readonly path: Argument;
      /** The target as typed, for Bash's ambiguous-redirect diagnostic. */
      readonly spelling: string;
    }
  | {
      readonly kind: "write";
      readonly fd: 1 | 2;
      readonly path: Argument;
      readonly append: boolean;
      readonly spelling: string;
    }
  | { readonly kind: "duplicate"; readonly fd: 1 | 2; readonly targetFd: 1 | 2 }
  /**
   * A here-document or here-string: no splitting, no globbing. A here-string
   * keeps its unquoted literals unquoted, which only tilde expansion observes.
   */
  | {
      readonly kind: "text";
      readonly fd: 0;
      readonly text: Argument;
      /** A here-string appends a newline after expansion. */
      readonly newline: boolean;
    };

export interface PlannedCommand {
  readonly kind: "command";
  /**
   * The literal command name. Null when the name word expands at run time
   * (`nameWord`) or when the command is only assignments and redirections.
   */
  readonly name: string | null;
  /** A name word with expansions; its first expanded field names the command. */
  readonly nameWord: Argument | null;
  /** Arguments after the name. */
  readonly args: readonly Argument[];
  /** Applied to the shell when there is no command, else to its environment only. */
  readonly assignments: readonly PlannedAssignment[];
  readonly redirections: readonly PlannedRedirection[];
  /** The one-based source line, for Bash-shaped builtin diagnostics. */
  readonly line: number;
}

interface PlannedCompoundBase {
  /** Bound once around the whole body, before it runs. */
  readonly redirections: readonly PlannedRedirection[];
  /** The one-based source line of the opening word. */
  readonly line: number;
}

/** `( … )`: the body runs on a copy of the shell state. */
export interface PlannedSubshell extends PlannedCompoundBase {
  readonly kind: "subshell";
  readonly body: Plan;
}

/** `{ …; }`: the body runs in the current shell. */
export interface PlannedGroup extends PlannedCompoundBase {
  readonly kind: "group";
  readonly body: Plan;
}

export interface PlannedIf extends PlannedCompoundBase {
  readonly kind: "if";
  readonly clauses: readonly { readonly condition: Plan; readonly body: Plan }[];
  readonly otherwise: Plan | null;
}

/** The loop structure only; the word list is expanded and bound during execution. */
export interface PlannedFor extends PlannedCompoundBase {
  readonly kind: "for";
  readonly name: string;
  readonly words: readonly Argument[];
  readonly body: Plan;
}

export type PlannedCompound = PlannedSubshell | PlannedGroup | PlannedIf | PlannedFor;

export type PlannedStage = PlannedCommand | PlannedCompound;

export interface PlannedPipeline {
  readonly commands: readonly PlannedStage[];
  /**
   * Downstream demand, when a trailing `head -N` makes it statically known.
   *
   * This is a *hint*, not the bound. The executor is pull-based, so a
   * consumer that stops pulling already stops the source; the hint exists
   * to size the first discovery page. The Wave A probe showed a fixed page
   * costs a second round trip as soon as match density drops below 2/3, so
   * sources seed at `2 * limitHint`.
   *
   * Null when a blocking stage (`sort`, `wc`) sits between the source and
   * the limiter and swallows the demand, and whenever a stage is compound:
   * its body's pipelines carry their own hints.
   */
  readonly limitHint: number | null;
  /** Rewrites applied, in order. Surfaced by tests and by `explain()`. */
  readonly fusions: readonly string[];
}

export interface PlannedStep {
  readonly pipeline: PlannedPipeline;
  readonly negated: boolean;
  readonly connector: Connector | null;
}

export interface Plan {
  readonly steps: readonly PlannedStep[];
}

/**
 * What the planner needs to know about a command to rewrite around it. Flag
 * parsing lives in the command itself; this is only what changes the *shape*
 * of the query.
 */
export interface CommandTraits {
  /** Must see all of its input before it can emit anything. */
  readonly blocking: boolean;
  /** Emits a bounded prefix of its input: `head`. */
  readonly limiter: boolean;
}

const DEFAULT_TRAITS: CommandTraits = { blocking: false, limiter: false };

const TRAITS: ReadonlyMap<string, CommandTraits> = new Map([
  ["grep", { blocking: false, limiter: false }],
  ["rg", { blocking: false, limiter: false }],
  ["find", { blocking: false, limiter: false }],
  ["ls", { blocking: false, limiter: false }],
  ["cat", { blocking: false, limiter: false }],
  ["stat", { blocking: false, limiter: false }],
  ["head", { blocking: false, limiter: true }],
  // `tail` is not a limiter: it needs the end of its input, so it cannot
  // bound what the source produces. Bounded in memory, not in demand.
  ["tail", { blocking: true, limiter: false }],
  ["sort", { blocking: true, limiter: false }],
  ["uniq", { blocking: false, limiter: false }],
  ["wc", { blocking: true, limiter: false }],
  ["sed", { blocking: false, limiter: false }],
  ["xargs", { blocking: true, limiter: false }],
  ["cp", { blocking: false, limiter: false }],
  ["mv", { blocking: false, limiter: false }],
  ["rm", { blocking: false, limiter: false }],
  ["mkdir", { blocking: false, limiter: false }],
  ["touch", { blocking: false, limiter: false }],
  ["echo", DEFAULT_TRAITS],
  ["pwd", DEFAULT_TRAITS],
  ["true", DEFAULT_TRAITS],
  ["false", DEFAULT_TRAITS],
  ["which", DEFAULT_TRAITS],
  ["cd", DEFAULT_TRAITS],
]);

export function traitsFor(name: string | null): CommandTraits {
  return (name === null ? undefined : TRAITS.get(name)) ?? DEFAULT_TRAITS;
}

export function isKnownCommand(name: string): boolean {
  return TRAITS.has(name);
}
