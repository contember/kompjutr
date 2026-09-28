// find's parsed expression. The parser in `../find-expression.ts` builds it;
// the walkers in this directory evaluate it.

import type { EntryType } from "../../../fs/types.js";

/** `+N`, `-N`, or `N` in a numeric test. */
export type Comparison = "greater" | "less" | "equal";

export type Expression =
  | { readonly kind: "and" | "or"; readonly left: Expression; readonly right: Expression }
  | { readonly kind: "not"; readonly operand: Expression }
  | {
      readonly kind: "name" | "path";
      readonly pattern: string;
      readonly ignoreCase: boolean;
      test(value: string): boolean;
    }
  | { readonly kind: "type"; readonly types: ReadonlySet<EntryType> }
  | { readonly kind: "constant"; readonly value: boolean }
  | { readonly kind: "print"; readonly terminator: string }
  | { readonly kind: "prune" }
  | { readonly kind: "empty" }
  | {
      readonly kind: "size";
      readonly comparison: Comparison;
      readonly count: number;
      /** Bytes per unit; the file size is rounded up to whole units. */
      readonly unit: number;
    }
  | { readonly kind: "newer"; readonly reference: string }
  | {
      readonly kind: "age";
      readonly comparison: Comparison;
      readonly amount: number;
      readonly unit: "minutes" | "days";
    }
  | {
      readonly kind: "exec";
      /** `-exec … {} +`: paths accumulate and run in batches. */
      readonly batched: boolean;
      /** The command and its arguments; a batch's trailing `{}` is not included. */
      readonly argv: readonly string[];
    }
  | { readonly kind: "delete" };

export interface FindCommand {
  readonly startingPoints: readonly string[];
  readonly expression: Expression;
  readonly maxDepth: number | null;
  readonly minDepth: number;
  /** `-depth`, `-d`, or implied by `-delete`: a directory after its contents. */
  readonly depthFirst: boolean;
}

/** A GNU diagnostic: find exits 1 on a malformed expression. */
export class FindUsageError extends Error {}

/** Every node of `expression`, depth first, left before right. */
export function* nodes(expression: Expression): Generator<Expression> {
  yield expression;
  switch (expression.kind) {
    case "and":
    case "or":
      yield* nodes(expression.left);
      yield* nodes(expression.right);
      return;
    case "not":
      yield* nodes(expression.operand);
      return;
    default:
      return;
  }
}
