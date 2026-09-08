// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from the xdiff library as it appears in git, which derives from
// LibXDiff, Copyright (C) 2003 Davide Libenzi <davidel@xmailserver.org>.
// LGPL-2.1-or-later, like the original. See ./LICENSE — this directory is
// the one part of kompjutr that is not MIT.

/** One contiguous run of changed lines, as `xdl_build_script` emits it. */
export interface ChangeGroup {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/**
 * The changed-line flags. Indices -1 and `length` are always false, which
 * is the sentinel the group walkers rely on instead of bounds checks.
 */
export class Marks {
  readonly #flags: Uint8Array;

  constructor(length: number) {
    this.#flags = new Uint8Array(length + 2);
  }

  get(index: number): boolean {
    return this.#flags[index + 1] === 1;
  }

  set(index: number, value: boolean): void {
    this.#flags[index + 1] = value ? 1 : 0;
  }
}

/** One side of the comparison, mirroring xdiff's `xdfile_t`. */
export interface ByteRecord {
  bytes: Uint8Array;
  start: number;
  end: number;
}

export type LineRecord = string | ByteRecord;

export interface Side {
  lines: LineRecord[];
  /** Equality class of each line: two lines match iff their classes do. */
  classes: number[];
  changed: Marks;
  /** Indices of the lines Myers actually runs over. */
  reference: number[];
  dstart: number;
  dend: number;
}

export interface Environment {
  maxCost: number;
  snakeCount: number;
  heuristicMinimum: number;
}

export interface DiffLinesOptions {
  /** Turn off git's indent heuristic. On by default, as in git. */
  indentHeuristic?: boolean;
  /** Reject the next change group before retaining it. */
  maxChanges?: number;
}
