// `find`. Each starting point is one stat plus keyset scan pages; `-prune`
// and `-maxdepth` resume the scan past the skipped subtree instead of reading
// it. An expression that is only `-name`, `-path`, and `-print` lowers to an indexed GLOB narrowed by the `-name` pattern's literal tail.
// Results print under the starting point as typed, as GNU find does. The
// walks, `-exec`, and `-delete` live in `find/`.

import { type ByteStream, owned } from "../exec/bytes.js";
import { type Command, fail } from "../exec/context.js";
import { displayUnder } from "../exec/display.js";
import { resolve } from "../exec/execute.js";
import { sqlGlobFor } from "../exec/glob.js";
import { Deleter } from "./find/delete.js";
import { type Candidate, type Evaluation, evaluate } from "./find/evaluate.js";
import { ExecRunner } from "./find/exec.js";
import { type Expression, type FindCommand, FindUsageError, nodes } from "./find/types.js";
import { postOrder, preOrder, realPrefix, type Walk } from "./find/walk.js";
import { parseFind } from "./find-expression.js";
import { UsageError } from "./flags.js";

const GLOB_PAGE = 1_000;

export const find: Command = (context) => {
  let command: FindCommand;
  try {
    command = parseFind(context.argv);
  } catch (error) {
    if (error instanceof FindUsageError) return fail(context, error.message, 1);
    if (error instanceof UsageError) return fail(context, error.message, 2);
    throw error;
  }

  const expressionNodes = [...nodes(command.expression)];
  const newer = new Map<string, number>();
  for (const node of expressionNodes) {
    if (node.kind !== "newer" || newer.has(node.reference)) continue;
    const reference = context.fs.stat(resolve(context.cwd, node.reference));
    if (reference === null) {
      return fail(context, `'${node.reference}': No such file or directory`, 1);
    }
    newer.set(node.reference, reference.mtime);
  }

  const live = expressionNodes.some((node) => node.kind === "exec");
  const deleter = expressionNodes.some((node) => node.kind === "delete")
    ? new Deleter(context, live)
    : null;
  const exec = new ExecRunner(
    context,
    expressionNodes.flatMap((node) => (node.kind === "exec" ? [node] : [])),
    () => deleter?.flush(),
  );
  const evaluation: Evaluation = { now: context.now(), newer, exec };
  const needsEmptiness = expressionNodes.some(
    (node) => node.kind === "empty" || node.kind === "delete",
  );

  let missing = false;
  const lost = (display: string): void => {
    context.warn(`'${display}': No such file or directory`);
    missing = true;
  };
  const stream = (async function* (): AsyncGenerator<Uint8Array, void, undefined> {
    for (const operand of command.startingPoints) {
      const start = resolve(context.cwd, operand);
      // A trailing slash names a directory: GNU follows a symlink to one and
      // refuses anything else before the walk.
      const namesDirectory = /\/\.?$/.test(operand);
      const root = namesDirectory ? context.fs.statTarget(start) : context.fs.stat(start);
      if (root === null) {
        lost(operand);
        continue;
      }
      if (namesDirectory && root.type !== "dir") {
        context.warn(`'${operand}': Not a directory`);
        missing = true;
        continue;
      }
      const walk: Walk = {
        context,
        command,
        evaluation,
        operand,
        start,
        root,
        live,
        needsEmptiness,
        lost,
      };
      const pattern = globNarrowing(command, start);
      if (command.depthFirst) {
        yield* postOrder(walk, deleter);
      } else if (pattern === null || root.type !== "dir") {
        yield* preOrder(walk);
      } else {
        yield* globbed(walk, pattern);
      }
    }
    deleter?.flush();
    yield* exec.finish();
  })();
  const failed = (): boolean => missing || exec.failed || (deleter?.failed ?? false);
  const release = (): void => {
    exec.release();
    deleter?.discard();
  };
  return {
    stdout: owned(live || deleter !== null ? new FinishingStream(stream) : stream, release),
    status: () => (failed() ? 1 : 0),
    truncated: () => exec.truncated,
  };
};

/**
 * The starting point, then descendants whose path matches a SQL GLOB superset,
 * evaluated without metadata.
 */
async function* globbed(walk: Walk, pattern: string): ByteStream {
  const { context, command, evaluation, operand, start, root } = walk;
  const rootCandidate: Candidate = {
    display: operand,
    type: root.type,
    stat: () => root,
    emptyDirectory: unreachable,
    remove: unreachable,
  };
  const rootVisit = { pruned: false };
  yield* evaluate(command.expression, rootCandidate, evaluation, rootVisit);

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
      const candidate: Candidate = {
        display: displayUnder(operand, real(path), path),
        type: null,
        stat: () => null,
        emptyDirectory: unreachable,
        remove: unreachable,
      };
      yield* evaluate(command.expression, candidate, evaluation, { pruned: false });
    }
    if (page.next === null) return;
    after = page.next;
  }
}

/**
 * A reader that stops early must not abandon side effects: closing runs the
 * rest of the walk with its output discarded, so queued deletions and pending
 * `-exec` batches still happen. The operation ceiling still bounds it.
 */
class FinishingStream implements AsyncIterableIterator<Uint8Array, void, undefined> {
  constructor(private readonly source: AsyncGenerator<Uint8Array, void, undefined>) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array, void, undefined> {
    return this;
  }

  next(): Promise<IteratorResult<Uint8Array, void>> {
    return this.source.next();
  }

  async return(): Promise<IteratorResult<Uint8Array, void>> {
    for (let next = await this.source.next(); next.done !== true; next = await this.source.next()) {
      // Discarded: nobody reads it any more.
    }
    return { done: true, value: undefined };
  }

  throw(error: unknown): Promise<IteratorResult<Uint8Array, void>> {
    return this.source.throw(error);
  }
}

function unreachable(): boolean {
  throw new Error("find: the indexed walk evaluates names only");
}

/**
 * The GLOB for an expression made only of `-name`, `-path`, and `-print`,
 * narrowed by a case-sensitive `-name`. Types, sizes, times, depths, and
 * `-prune` need the scan's entry metadata; `-o` or `!` could admit paths a
 * GLOB excludes; and an `-exec` may change the tree, which only the scan walk
 * re-reads.
 */
function globNarrowing(command: FindCommand, start: string): string | null {
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
