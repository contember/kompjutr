// Word expansion for command arguments, redirection targets, assignment
// values, and here-text: braces and tildes (sync), then parameters and
// substitutions (async, `expansion/segments.ts`), then field splitting and
// pathname expansion.

import { join, normalize } from "../../fs/path.js";
import { expandTildes } from "../plan/tilde.js";
import type { Argument, FlatPart } from "../plan/types.js";
import { flatParts, generateWords, hasBraces } from "./braces.js";
import { type BoundedFs, ShellLimitError } from "./context.js";
import { fieldHasGlob, fieldPattern, fieldText, splitFields } from "./expansion/fields.js";
import {
  type Expansion,
  homeOf,
  joinSegments,
  type Parameters,
  resolveParts,
} from "./expansion/segments.js";
import { compileGlob, sqlGlobFor } from "./glob.js";
import { utf8Bytes } from "./utf8.js";

const ARGUMENT_COUNT_MAX = 10_000;
// Nested loops multiply their word lists; one run-wide count keeps a run
// inside the Worker's CPU-time limit, sized by the same ceiling as argv.
const LOOP_ITERATION_MAX = ARGUMENT_COUNT_MAX;
const PATH_PAGE_MAX = 1_000;

export type { Captured, Expansion, Parameters } from "./expansion/segments.js";
export { ExpansionFailure } from "./expansion/segments.js";

/** Counts loop iterations across a whole run, subshells and pipeline stages included. */
export class LoopBudget {
  #iterations = 0;

  charge(): void {
    this.#iterations++;
    if (this.#iterations > LOOP_ITERATION_MAX) {
      throw new ShellLimitError(
        "arguments",
        `for: exceeded the ${LOOP_ITERATION_MAX}-iteration loop iteration limit`,
      );
    }
  }
}

export interface ExpandedArguments {
  readonly argv: readonly string[];
  release(): void;
}

export async function expandArguments(
  args: readonly Argument[],
  expansion: Expansion,
): Promise<ExpandedArguments> {
  const { fs, cwd } = expansion;
  const out: string[] = [];
  const releases: Array<() => void> = [];
  const push = (value: string): void => {
    if (out.length >= ARGUMENT_COUNT_MAX) throw argumentLimit();
    const valueBytes = utf8Bytes(value);
    releases.push(fs.retained.retain(valueBytes, "command arguments"));
    out.push(value);
  };

  try {
    for (const word of words(args, expansion.parameters)) {
      const held: Array<() => void> = [];
      try {
        const segments = await resolveParts(word.parts, expansion, held);
        if (word.kind === "declaration") {
          push(joinSegments(segments));
          continue;
        }
        for (const field of splitFields(segments)) {
          const value = fieldText(field);
          if (!fieldHasGlob(field)) {
            push(value);
            continue;
          }
          let matched = false;
          for (const match of expandGlob(fieldPattern(field), fs, cwd)) {
            push(match);
            matched = true;
          }
          if (!matched) push(value);
        }
      } finally {
        for (const release of held) release();
      }
    }
  } catch (error) {
    for (const release of releases) release();
    throw error;
  }
  return {
    argv: out,
    release: () => {
      for (const release of releases) release();
    },
  };
}

/** A redirection target's one field, or null when it expands to none or several. */
export async function expandTarget(arg: Argument, expansion: Expansion): Promise<string | null> {
  const expanded = await expandArguments([arg], expansion);
  try {
    const first = expanded.argv[0];
    return expanded.argv.length === 1 && first !== undefined ? first : null;
  } finally {
    expanded.release();
  }
}

/**
 * One string, as an assignment value or here-text expands: tilde, parameter,
 * and command substitution, with no splitting or pathname expansion.
 */
export async function expandText(argument: Argument, expansion: Expansion): Promise<string> {
  const parts = expandTildes(
    flatParts(argument.parts),
    argument.kind,
    homeOf(expansion.parameters),
  );
  const held: Array<() => void> = [];
  try {
    return joinSegments(await resolveParts(parts, expansion, held));
  } finally {
    for (const release of held) release();
  }
}

function argumentLimit(): ShellLimitError {
  return new ShellLimitError(
    "arguments",
    `E2BIG: expanded argv exceeds ${ARGUMENT_COUNT_MAX} entries`,
  );
}

/**
 * Each argument's words after brace and tilde expansion. Brace-generated
 * words count against the argv ceiling as they arrive, so a generator that
 * yields only empty words is bounded too.
 */
function* words(
  args: readonly Argument[],
  parameters: Parameters,
): Generator<{ readonly kind: Argument["kind"]; readonly parts: readonly FlatPart[] }> {
  let generated = 0;
  for (const arg of args) {
    if (!hasBraces(arg.parts)) {
      yield {
        kind: arg.kind,
        parts: expandTildes(flatParts(arg.parts), arg.kind, homeOf(parameters)),
      };
      continue;
    }
    for (const word of generateWords(arg.parts)) {
      generated++;
      if (generated > ARGUMENT_COUNT_MAX) throw argumentLimit();
      yield { kind: "word", parts: expandTildes(word, "word", homeOf(parameters)) };
    }
  }
}

/**
 * Paths matching `pattern`, relative to `cwd` when the pattern is relative.
 *
 * The SQL GLOB narrows and JS decides, because SQLite's `*` crosses `/` and
 * a shell's does not. Over the ceiling the narrowing is dropped and the
 * subtree is scanned instead — correct either way, only slower.
 */
function* expandGlob(pattern: string, fs: BoundedFs, cwd: string): Generator<string> {
  const isAbsolute = pattern.startsWith("/");
  const absolute = isAbsolute ? normalize(pattern) : join(cwd, pattern);
  const fixed = absolute.slice(0, Math.max(0, absolute.search(/[*?[]/)));
  const root = fixed.includes("/") ? fixed.slice(0, fixed.lastIndexOf("/")) || "/" : "/";
  const matcher = compileGlob(absolute);
  const displayRoot = isAbsolute ? null : relativeGlobRoot(pattern);

  const sql = sqlGlobFor(absolute);
  if (sql !== null) {
    let after: string | undefined;
    for (;;) {
      const page = fs.globPage(
        root,
        sql,
        after === undefined ? { limit: PATH_PAGE_MAX } : { after, limit: PATH_PAGE_MAX },
      );
      for (const path of page.paths) {
        if (matcher.test(path)) yield projectGlobMatch(path, root, displayRoot);
      }
      if (page.next === null) return;
      after = page.next;
    }
  }

  let after: string | undefined;
  for (;;) {
    const page = fs.scan(
      root,
      after === undefined ? { limit: PATH_PAGE_MAX } : { after, limit: PATH_PAGE_MAX },
    );
    for (const entry of page) {
      if (matcher.test(entry.path)) yield projectGlobMatch(entry.path, root, displayRoot);
    }
    if (page.length < PATH_PAGE_MAX) return;
    after = page[page.length - 1]?.path;
    if (after === undefined) return;
  }
}

function relativeGlobRoot(pattern: string): string {
  const metacharacter = pattern.search(/[*?[]/);
  const fixed = pattern.slice(0, Math.max(0, metacharacter));
  const slash = fixed.lastIndexOf("/");
  return slash === -1 ? "" : fixed.slice(0, slash);
}

function projectGlobMatch(path: string, root: string, displayRoot: string | null): string {
  if (displayRoot === null) return path;
  const suffix = root === "/" ? path.slice(1) : path.slice(root.length + 1);
  if (displayRoot === "") return suffix;
  return `${displayRoot}/${suffix}`;
}

export function resolve(cwd: string, path: string): string {
  return path.startsWith("/") ? normalize(path) : join(cwd, path);
}
