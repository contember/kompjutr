// What one op did on one side, normalised so the two sides compare.

/**
 * `stopped` is an integration that paused for the user — a conflict, or an
 * empty cherry-pick waiting for skip — and `empty` a revert that had nothing
 * to undo and left no state behind. git reports both with exit status 1;
 * kompjutr returns a result object.
 */
export type OutcomeKind = "clean" | "stopped" | "empty" | "failed";

export interface Outcome {
  kind: OutcomeKind;
  /** kompjutr's stable `error.code`, or git's exit status. */
  detail?: string;
  /** kompjutr threw something without a stable `code`. */
  crash?: boolean;
}

export const CLEAN: Outcome = { kind: "clean" };
export const STOPPED: Outcome = { kind: "stopped" };
export const EMPTY: Outcome = { kind: "empty" };
