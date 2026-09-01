// What the executor runs. An AST says what was typed; a plan says what will
// be asked of the filesystem.
//
// Nothing here imports `src/fs/`: planning is pure, so every rewrite in
// `plan.ts` is testable without a database. Anything that needs the
// filesystem — expanding a glob, resolving a path — is *marked* here and
// performed by the executor.

import type { Connector } from "../parse/ast.js";

export type ArgumentPart =
  | { readonly kind: "literal"; readonly value: string; readonly quoted: boolean }
  | { readonly kind: "parameter"; readonly name: string; readonly quoted: boolean }
  | { readonly kind: "glob"; readonly value: string };

/** One argument retained as ordered parts until its run environment is known. */
export interface Argument {
  readonly kind: "word";
  readonly parts: readonly ArgumentPart[];
}

/** One descriptor binding, retained in source order for left-to-right resolution. */
export type PlannedRedirection =
  | { readonly kind: "read"; readonly fd: 0; readonly path: Argument }
  | {
      readonly kind: "write";
      readonly fd: 1 | 2;
      readonly path: Argument;
      readonly append: boolean;
    }
  | { readonly kind: "duplicate"; readonly fd: 1 | 2; readonly targetFd: 1 | 2 };

export interface PlannedCommand {
  readonly name: string;
  /** Arguments after the name. */
  readonly args: readonly Argument[];
  readonly redirections: readonly PlannedRedirection[];
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

export function traitsFor(name: string): CommandTraits {
  return TRAITS.get(name) ?? DEFAULT_TRAITS;
}

export function isKnownCommand(name: string): boolean {
  return TRAITS.has(name);
}
