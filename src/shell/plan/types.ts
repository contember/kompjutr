// What the executor runs. An AST says what was typed; a plan says what will
// be asked of the filesystem.
//
// Nothing here imports `src/fs/`: planning is pure, so every rewrite in
// `plan.ts` is testable without a database. Anything that needs the
// filesystem — expanding a glob, resolving a path — is *marked* here and
// performed by the executor.

import type { Connector } from "../parse/ast.js";

/**
 * One argument. A glob cannot be resolved without the filesystem, so it is
 * carried as a pattern rather than flattened to text.
 */
export type Argument =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "glob"; readonly pattern: string };

/** Where a stream goes. `merge` is `2>&1`; `drop` is `2>/dev/null`. */
export type StderrMode = "inherit" | "drop" | "merge";

export interface FileTarget {
  readonly path: Argument;
  readonly append: boolean;
}

export interface PlannedCommand {
  readonly name: string;
  /** Arguments after the name. */
  readonly args: readonly Argument[];
  readonly stderr: StderrMode;
  /** `> file` / `>> file`. Null means the stage's own stdout. */
  readonly stdout: FileTarget | null;
  /** `< file`. Null means the previous stage, or empty for the first. */
  readonly stdin: Argument | null;
}

export interface PlannedPipeline {
  readonly commands: readonly PlannedCommand[];
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
   * the limiter and swallows the demand.
   */
  readonly limitHint: number | null;
  /** Rewrites applied, in order. Surfaced by tests and by `explain()`. */
  readonly fusions: readonly string[];
}

export interface PlannedStep {
  readonly pipeline: PlannedPipeline;
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
  /** Reads the filesystem when it is first in the pipeline. */
  readonly reads: boolean;
  /** Must see all of its input before it can emit anything. */
  readonly blocking: boolean;
  /** Emits a bounded prefix of its input: `head`. */
  readonly limiter: boolean;
}

const DEFAULT_TRAITS: CommandTraits = { reads: false, blocking: false, limiter: false };

const TRAITS: ReadonlyMap<string, CommandTraits> = new Map([
  ["grep", { reads: true, blocking: false, limiter: false }],
  ["rg", { reads: true, blocking: false, limiter: false }],
  ["find", { reads: true, blocking: false, limiter: false }],
  ["ls", { reads: true, blocking: false, limiter: false }],
  ["cat", { reads: true, blocking: false, limiter: false }],
  ["stat", { reads: true, blocking: false, limiter: false }],
  ["head", { reads: true, blocking: false, limiter: true }],
  // `tail` is not a limiter: it needs the end of its input, so it cannot
  // bound what the source produces. Bounded in memory, not in demand.
  ["tail", { reads: true, blocking: true, limiter: false }],
  ["sort", { reads: false, blocking: true, limiter: false }],
  ["uniq", { reads: false, blocking: false, limiter: false }],
  ["wc", { reads: true, blocking: true, limiter: false }],
  ["sed", { reads: true, blocking: false, limiter: false }],
  ["xargs", { reads: false, blocking: true, limiter: false }],
  ["cp", { reads: true, blocking: false, limiter: false }],
  ["mv", { reads: true, blocking: false, limiter: false }],
  ["rm", { reads: true, blocking: false, limiter: false }],
  ["mkdir", { reads: true, blocking: false, limiter: false }],
  ["touch", { reads: true, blocking: false, limiter: false }],
  ["echo", DEFAULT_TRAITS],
  ["pwd", DEFAULT_TRAITS],
  ["true", DEFAULT_TRAITS],
  ["false", DEFAULT_TRAITS],
  ["which", DEFAULT_TRAITS],
  ["cd", DEFAULT_TRAITS],
]);

export function traitsFor(name: string): CommandTraits {
  return TRAITS.get(name) ?? DEFAULT_TRAITS;
}

export function isKnownCommand(name: string): boolean {
  return TRAITS.has(name);
}
