// One entry through find's expression, left to right with short-circuit
// operators, as GNU evaluates it. Output — `-print` lines and whatever an
// `-exec` command writes — is yielded in evaluation order; the generator's
// return value is the expression's truth.

import type { EntryType, Stat } from "../../../fs/types.js";
import { encode } from "../../exec/bytes.js";
import type { ExecRunner } from "./exec.js";
import type { Comparison, Expression } from "./types.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
/**
 * The filesystem stores no size for a directory. `-size` sees the block size
 * the Node compat layer reports (`fs/compat/node-values.ts`), as ext4 does.
 */
const DIRECTORY_SIZE = 4096;

export interface Candidate {
  /** The path as find prints it: under its starting point as typed. */
  readonly display: string;
  /** From the listing; null on the indexed-glob path, whose expressions test names only. */
  readonly type: EntryType | null;
  /** Null on the glob path, or after reporting an entry an `-exec` removed. */
  stat(): Stat | null;
  /** Whether a directory has no entries left. Asked of directories only. */
  emptyDirectory(): boolean;
  /** `-delete`; false when the entry could not be removed. */
  remove(): boolean;
}

export interface Evaluation {
  /** Milliseconds, sampled once when find starts, as GNU does. */
  readonly now: number;
  /** `-newer` reference operand → its mtime, stat'ed before the walk. */
  readonly newer: ReadonlyMap<string, number>;
  readonly exec: ExecRunner;
}

/** What one entry's evaluation asked of the walk. */
export interface Visit {
  pruned: boolean;
}

export async function* evaluate(
  expression: Expression,
  candidate: Candidate,
  evaluation: Evaluation,
  visit: Visit,
): AsyncGenerator<Uint8Array, boolean, undefined> {
  switch (expression.kind) {
    case "and":
      return (
        (yield* evaluate(expression.left, candidate, evaluation, visit)) &&
        (yield* evaluate(expression.right, candidate, evaluation, visit))
      );
    case "or":
      return (
        (yield* evaluate(expression.left, candidate, evaluation, visit)) ||
        (yield* evaluate(expression.right, candidate, evaluation, visit))
      );
    case "not":
      return !(yield* evaluate(expression.operand, candidate, evaluation, visit));
    case "name":
      return expression.test(baseName(candidate.display));
    case "path":
      return expression.test(candidate.display);
    case "type":
      return candidate.type !== null && expression.types.has(candidate.type);
    case "constant":
      return expression.value;
    case "print":
      yield encode(`${candidate.display}${expression.terminator}`);
      return true;
    case "prune":
      visit.pruned = true;
      return true;
    case "empty":
      return isEmpty(candidate);
    case "size": {
      const stat = candidate.stat();
      if (stat === null) return false;
      const size = stat.type === "dir" ? DIRECTORY_SIZE : stat.size;
      return compare(Math.ceil(size / expression.unit), expression.comparison, expression.count);
    }
    case "newer": {
      const stat = candidate.stat();
      const reference = evaluation.newer.get(expression.reference);
      return stat !== null && reference !== undefined && stat.mtime > reference;
    }
    case "age": {
      const stat = candidate.stat();
      return stat !== null && isAged(expression, evaluation.now - stat.mtime);
    }
    case "exec":
      return expression.batched
        ? yield* evaluation.exec.queue(expression, candidate.display)
        : yield* evaluation.exec.each(expression.argv, candidate.display);
    case "delete":
      return candidate.remove();
  }
}

function isEmpty(candidate: Candidate): boolean {
  if (candidate.type === "file") return candidate.stat()?.size === 0;
  return candidate.type === "dir" && candidate.emptyDirectory();
}

function compare(value: number, comparison: Comparison, operand: number): boolean {
  if (comparison === "greater") return value > operand;
  if (comparison === "less") return value < operand;
  return value === operand;
}

/**
 * GNU's time windows. `-mmin N` means an age in `[N-1, N)` minutes and
 * `-mmin +N` older than N minutes; `-mtime` counts whole days elapsed, so
 * `-mtime N` is `[N, N+1)` days and `-mtime +N` is older than N+1 days.
 */
function isAged(test: Extract<Expression, { readonly kind: "age" }>, age: number): boolean {
  const unit = test.unit === "minutes" ? MINUTE : DAY;
  const upper = test.unit === "minutes" ? test.amount * unit : (test.amount + 1) * unit;
  if (test.comparison === "greater") return test.unit === "minutes" ? age > upper : age >= upper;
  if (test.comparison === "less") return age < test.amount * unit;
  return age >= upper - unit && age < upper;
}

/** GNU matches `-name` against the last component, ignoring trailing slashes. */
function baseName(display: string): string {
  const trimmed = display.length > 1 ? display.replace(/\/+$/, "") : display;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}
