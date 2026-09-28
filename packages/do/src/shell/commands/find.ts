// `find`. Each starting point is one stat plus keyset scan pages; `-prune`
// and `-maxdepth` resume the scan past the skipped subtree instead of reading
// it. An expression that is only `-name`, `-path`, and actions lowers to an
// indexed GLOB narrowed by the `-name` pattern's literal tail. Results print
// under the starting point as typed, as GNU find does.

import { orderedScan } from "../../fs/store/scan/scan-stream.js";
import type { EntryType } from "../../fs/types.js";
import { type ByteStream, encode } from "../exec/bytes.js";
import { type Command, type CommandContext, fail } from "../exec/context.js";
import { displayUnder } from "../exec/display.js";
import { resolve } from "../exec/execute.js";
import { sqlGlobFor } from "../exec/glob.js";
import { type Expression, FindUsageError, parseFind } from "./find-expression.js";
import { UsageError } from "./flags.js";

const GLOB_PAGE = 1_000;

interface Candidate {
  readonly display: string;
  readonly type: EntryType | null;
}

interface Visit {
  readonly output: string[];
  pruned: boolean;
}

export const find: Command = (context) => {
  let command: ReturnType<typeof parseFind>;
  try {
    command = parseFind(context.argv);
  } catch (error) {
    if (error instanceof FindUsageError) return fail(context, error.message, 1);
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }

  let status = 0;
  const stream = (function* (): ByteStream {
    for (const operand of command.startingPoints) {
      const start = resolve(context.cwd, operand);
      const stat = context.fs.stat(start);
      if (stat === null) {
        context.warn(`'${operand}': No such file or directory`);
        status = 1;
        continue;
      }
      const root = visit(command.expression, { display: operand, type: stat.type });
      if (command.minDepth === 0) yield* emit(root.output);
      const descend =
        stat.type === "dir" && !root.pruned && (command.maxDepth === null || command.maxDepth > 0);
      if (!descend) continue;

      const pattern = globNarrowing(command, start);
      const results =
        pattern === null
          ? scanned(context, command, operand, start)
          : globbed(context, command.expression, operand, start, pattern);
      for (const output of results) yield* emit(output);
    }
  })();
  return { stdout: stream, status: () => status, truncated: () => false };
};

/**
 * Every descendant in path order. A directory that `-prune` selected or that
 * sits at `-maxdepth` is skipped by the ordered scan, which resumes past its
 * subtree rather than reading it.
 */
function* scanned(
  context: CommandContext,
  command: ReturnType<typeof parseFind>,
  operand: string,
  start: string,
): Generator<string[], void, undefined> {
  const real = realPrefix(context, start);
  let skipLast = false;
  const entries = orderedScan((options) => context.fs.scan(start, options), {
    pruneDirectory: () => skipLast,
  });
  for (const entry of entries) {
    const prefix = real(entry.path);
    const depth = entry.path.slice(prefix === "/" ? 1 : prefix.length + 1).split("/").length;
    let pruned = false;
    if (depth >= command.minDepth) {
      const result = visit(command.expression, {
        display: displayUnder(operand, prefix, entry.path),
        type: entry.type,
      });
      pruned = result.pruned;
      yield result.output;
    }
    skipLast = pruned || (command.maxDepth !== null && depth >= command.maxDepth);
  }
}

/** Descendants whose path matches a SQL GLOB superset, evaluated without types. */
function* globbed(
  context: CommandContext,
  expression: Expression,
  operand: string,
  start: string,
  pattern: string,
): Generator<string[], void, undefined> {
  const real = realPrefix(context, start);
  const pageSize = Math.min(GLOB_PAGE, Math.max(1, (context.limitHint ?? 500) * 2));
  let after: string | undefined;
  for (;;) {
    const page = context.fs.globPage(
      start,
      pattern,
      after === undefined ? { limit: pageSize } : { after, limit: pageSize },
    );
    for (const path of page.paths) {
      const display = displayUnder(operand, real(path), path);
      yield visit(expression, { display, type: null }).output;
    }
    if (page.next === null) return;
    after = page.next;
  }
}

/**
 * Scan and glob results carry real paths. The resolved start usually is one,
 * so the realpath call is made only when a result shows otherwise.
 */
function realPrefix(context: CommandContext, start: string): (path: string) => string {
  let prefix: string | null = null;
  return (path) => {
    if (prefix === null) {
      prefix = isUnder(path, start) ? start : context.fs.realpath(start);
    }
    return prefix;
  };
}

/**
 * The GLOB for an expression made only of `-name`, `-path`, and actions,
 * narrowed by a case-sensitive `-name`. Types, depths, and `-prune` need the
 * scan's entry metadata, and `-o` or `!` could admit paths a GLOB excludes.
 */
function globNarrowing(command: ReturnType<typeof parseFind>, start: string): string | null {
  if (command.maxDepth !== null || command.minDepth > 0) return null;
  let tail: string | null = null;
  const conjuncts: Expression[] = [command.expression];
  for (let next = conjuncts.pop(); next !== undefined; next = conjuncts.pop()) {
    if (next.kind === "and") {
      conjuncts.push(next.left, next.right);
    } else if (next.kind === "name" || next.kind === "path") {
      if (next.kind === "name" && !next.ignoreCase) tail ??= literalTail(next.pattern);
    } else if (next.kind !== "print") {
      return null;
    }
  }
  if (tail === null) return null;
  return sqlGlobFor(`${start === "/" ? "" : start}/*${tail}`);
}

/** The longest trailing run with no fnmatch metacharacter. */
function literalTail(pattern: string): string {
  return /[^*?[\]\\]*$/.exec(pattern)?.[0] ?? "";
}

function visit(expression: Expression, candidate: Candidate): Visit {
  const state: Visit = { output: [], pruned: false };
  evaluate(expression, candidate, state);
  return state;
}

function evaluate(expression: Expression, candidate: Candidate, state: Visit): boolean {
  switch (expression.kind) {
    case "and":
      return (
        evaluate(expression.left, candidate, state) && evaluate(expression.right, candidate, state)
      );
    case "or":
      return (
        evaluate(expression.left, candidate, state) || evaluate(expression.right, candidate, state)
      );
    case "not":
      return !evaluate(expression.operand, candidate, state);
    case "name":
      return expression.test(baseName(candidate.display));
    case "path":
      return expression.test(candidate.display);
    case "type":
      return candidate.type !== null && expression.types.has(candidate.type);
    case "constant":
      return expression.value;
    case "print":
      state.output.push(`${candidate.display}${expression.terminator}`);
      return true;
    case "prune":
      state.pruned = true;
      return true;
  }
}

/** GNU matches `-name` against the last component, ignoring trailing slashes. */
function baseName(display: string): string {
  const trimmed = display.length > 1 ? display.replace(/\/+$/, "") : display;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

function isUnder(path: string, directory: string): boolean {
  return path.startsWith(directory === "/" ? "/" : `${directory}/`);
}

function* emit(output: readonly string[]): ByteStream {
  for (const line of output) yield encode(line);
}
