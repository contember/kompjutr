// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from the xdiff library as it appears in git, which derives from
// LibXDiff, Copyright (C) 2003 Davide Libenzi <davidel@xmailserver.org>.
// LGPL-2.1-or-later, like the original. See ./LICENSE — this directory is
// the one part of kompjutr that is not MIT.

// A port of git's xdiff line differ.
//
// Not "a Myers diff": the *placement* of a change group inside a run of
// equal lines is decided by the record-cleanup heuristic and by the change
// compaction pass, not by Myers, and those are what a patch has to agree
// with to match `git diff` byte for byte. So the pipeline is ported from
// xdiff/xprepare.c and xdiff/xdiffi.c rather than reinvented:
//
//   classify -> trim ends -> cleanup records -> Myers split -> compact
//
// Deliberately out: the patience and histogram algorithms, and the
// whitespace-insensitive comparison flags. git's defaults are Myers plus
// the indent heuristic, which is what we implement.

import { buildScript, compact } from "./myers-compact.js";
import { bogosqrt, classify, classifyBytes, cleanupRecords, trimEnds } from "./myers-prepare.js";
import { compare, Diagonals, HEUR_MIN_COST, MAX_COST_MIN, SNAKE_CNT } from "./myers-search.js";
import {
  type ByteRecord,
  type ChangeGroup,
  type DiffLinesOptions,
  type Environment,
  type LineRecord,
  Marks,
  type Side,
} from "./myers-state.js";

export { byteRecordsEqual } from "./myers-prepare.js";
export type { ByteRecord, ChangeGroup, DiffLinesOptions } from "./myers-state.js";

export function diffLines(
  oldLines: string[],
  newLines: string[],
  options: DiffLinesOptions = {},
): ChangeGroup[] {
  const { oldClasses, newClasses, inOld, inNew } = classify(oldLines, newLines);
  return diffClassified(oldLines, newLines, oldClasses, newClasses, inOld, inNew, options);
}

/** Byte-record variant used by xmerge without decoding arbitrary blob bytes. */
export function diffByteRecords(
  oldLines: ByteRecord[],
  newLines: ByteRecord[],
  options: DiffLinesOptions = {},
): ChangeGroup[] {
  const { oldClasses, newClasses, inOld, inNew } = classifyBytes(oldLines, newLines);
  return diffClassified(oldLines, newLines, oldClasses, newClasses, inOld, inNew, options);
}

function diffClassified(
  oldLines: LineRecord[],
  newLines: LineRecord[],
  oldClasses: number[],
  newClasses: number[],
  inOld: number[],
  inNew: number[],
  options: DiffLinesOptions,
): ChangeGroup[] {
  const left: Side = {
    lines: oldLines,
    classes: oldClasses,
    changed: new Marks(oldLines.length),
    reference: [],
    dstart: 0,
    dend: oldLines.length - 1,
  };
  const right: Side = {
    lines: newLines,
    classes: newClasses,
    changed: new Marks(newLines.length),
    reference: [],
    dstart: 0,
    dend: newLines.length - 1,
  };

  trimEnds(left, right);
  cleanupRecords(left, right, inNew, inOld);

  const diagonalCount = left.reference.length + right.reference.length + 3;
  const size = 2 * diagonalCount + 2;
  const offset = right.reference.length + 2;
  const environment: Environment = {
    maxCost: Math.max(bogosqrt(diagonalCount), MAX_COST_MIN),
    snakeCount: SNAKE_CNT,
    heuristicMinimum: HEUR_MIN_COST,
  };
  compare(
    left,
    0,
    left.reference.length,
    right,
    0,
    right.reference.length,
    new Diagonals(size, offset),
    new Diagonals(size, offset),
    false,
    environment,
  );

  const indentHeuristic = options.indentHeuristic !== false;
  compact(left, right, indentHeuristic);
  compact(right, left, indentHeuristic);
  return buildScript(left, right, options.maxChanges);
}
