// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from the xdiff library as it appears in git, which derives from
// LibXDiff, Copyright (C) 2003 Davide Libenzi <davidel@xmailserver.org>.
// LGPL-2.1-or-later, like the original. See ./LICENSE — this directory is
// the one part of kompjutr that is not MIT.

import { GitError } from "../common/errors.js";
import type { ChangeGroup, LineRecord, Side } from "./myers-state.js";

const MAX_INDENT = 200;
const MAX_BLANKS = 20;
const INDENT_HEURISTIC_MAX_SLIDING = 100;

// Weights from git's diff-slider-tools corpus. Smaller is a better split.
const START_OF_FILE_PENALTY = 1;
const END_OF_FILE_PENALTY = 21;
const TOTAL_BLANK_WEIGHT = -30;
const POST_BLANK_WEIGHT = 6;
const RELATIVE_INDENT_PENALTY = -4;
const RELATIVE_INDENT_WITH_BLANK_PENALTY = 10;
const RELATIVE_OUTDENT_PENALTY = 24;
const RELATIVE_OUTDENT_WITH_BLANK_PENALTY = 17;
const RELATIVE_DEDENT_PENALTY = 23;
const RELATIVE_DEDENT_WITH_BLANK_PENALTY = 17;
const INDENT_WEIGHT = 60;

interface Group {
  start: number;
  end: number;
}

function groupInit(side: Side): Group {
  const group = { start: 0, end: 0 };
  while (side.changed.get(group.end)) group.end++;
  return group;
}

function groupNext(side: Side, group: Group): boolean {
  if (group.end === side.lines.length) return false;
  group.start = group.end + 1;
  for (group.end = group.start; side.changed.get(group.end); group.end++);
  return true;
}

function groupPrevious(side: Side, group: Group): boolean {
  if (group.start === 0) return false;
  group.end = group.start - 1;
  for (group.start = group.end; side.changed.get(group.start - 1); group.start--);
  return true;
}

function groupSlideDown(side: Side, group: Group): boolean {
  if (group.end >= side.lines.length) return false;
  if (side.classes[group.start] !== side.classes[group.end]) return false;
  side.changed.set(group.start++, false);
  side.changed.set(group.end++, true);
  while (side.changed.get(group.end)) group.end++;
  return true;
}

function groupSlideUp(side: Side, group: Group): boolean {
  if (group.start === 0) return false;
  if (side.classes[group.start - 1] !== side.classes[group.end - 1]) return false;
  side.changed.set(--group.start, true);
  side.changed.set(--group.end, false);
  while (side.changed.get(group.start - 1)) group.start--;
  return true;
}

/**
 * `xdl_change_compact`: slide every change group as far as the surrounding
 * equal lines allow, then settle it where the diff reads best — aligned
 * with the other side's group if there is one, otherwise wherever the
 * indent heuristic scores lowest.
 */
export function compact(side: Side, other: Side, indentHeuristic: boolean): void {
  const group = groupInit(side);
  const otherGroup = groupInit(other);

  for (;;) {
    if (group.end !== group.start) {
      let size = 0;
      let earliestEnd = 0;
      let endMatchingOther = -1;
      do {
        size = group.end - group.start;
        endMatchingOther = -1;

        while (groupSlideUp(side, group)) groupPrevious(other, otherGroup);
        earliestEnd = group.end;
        if (otherGroup.end > otherGroup.start) endMatchingOther = group.end;

        for (;;) {
          if (!groupSlideDown(side, group)) break;
          groupNext(other, otherGroup);
          if (otherGroup.end > otherGroup.start) endMatchingOther = group.end;
        }
      } while (size !== group.end - group.start);

      if (group.end === earliestEnd) {
        // Nowhere to slide.
      } else if (endMatchingOther !== -1) {
        // Line back up with the other side so one change does not read as
        // an unrelated deletion plus an unrelated addition.
        while (otherGroup.end === otherGroup.start) {
          groupSlideUp(side, group);
          groupPrevious(other, otherGroup);
        }
      } else if (indentHeuristic) {
        let bestShift = -1;
        let bestScore: Score = { effectiveIndent: 0, penalty: 0 };
        let shift = earliestEnd;
        if (group.end - size - 1 > shift) shift = group.end - size - 1;
        if (group.end - INDENT_HEURISTIC_MAX_SLIDING > shift) {
          shift = group.end - INDENT_HEURISTIC_MAX_SLIDING;
        }
        for (; shift <= group.end; shift++) {
          const score: Score = { effectiveIndent: 0, penalty: 0 };
          addSplitScore(measureSplit(side, shift), score);
          addSplitScore(measureSplit(side, shift - size), score);
          if (bestShift === -1 || compareScores(score, bestScore) <= 0) {
            bestScore = score;
            bestShift = shift;
          }
        }
        while (group.end > bestShift) {
          groupSlideUp(side, group);
          groupPrevious(other, otherGroup);
        }
      }
    }

    if (!groupNext(side, group)) break;
    groupNext(other, otherGroup);
  }
}

interface Score {
  effectiveIndent: number;
  penalty: number;
}

interface Measurement {
  endOfFile: boolean;
  indent: number;
  preBlank: number;
  preIndent: number;
  postBlank: number;
  postIndent: number;
}

/** Indentation in columns, tabs counting to the next multiple of 8. */
function indentOf(line: LineRecord): number {
  let indent = 0;
  const length = typeof line === "string" ? line.length : line.end - line.start;
  for (let i = 0; i < length; i++) {
    const char = typeof line === "string" ? line.charCodeAt(i) : line.bytes[line.start + i]!;
    if (char === 0x20) indent += 1;
    else if (char === 0x09) indent += 8 - (indent % 8);
    else if (!isSpace(char)) return indent;
    if (indent >= MAX_INDENT) return MAX_INDENT;
  }
  return -1;
}

function isSpace(char: number): boolean {
  return (
    char === 0x20 ||
    char === 0x09 ||
    char === 0x0a ||
    char === 0x0b ||
    char === 0x0c ||
    char === 0x0d
  );
}

function measureSplit(side: Side, split: number): Measurement {
  const total = side.lines.length;
  const measurement: Measurement = {
    endOfFile: split >= total,
    indent: split >= total ? -1 : indentOf(side.lines[split]!),
    preBlank: 0,
    preIndent: -1,
    postBlank: 0,
    postIndent: -1,
  };
  for (let i = split - 1; i >= 0; i--) {
    measurement.preIndent = indentOf(side.lines[i]!);
    if (measurement.preIndent !== -1) break;
    measurement.preBlank += 1;
    if (measurement.preBlank === MAX_BLANKS) {
      measurement.preIndent = 0;
      break;
    }
  }
  for (let i = split + 1; i < total; i++) {
    measurement.postIndent = indentOf(side.lines[i]!);
    if (measurement.postIndent !== -1) break;
    measurement.postBlank += 1;
    if (measurement.postBlank === MAX_BLANKS) {
      measurement.postIndent = 0;
      break;
    }
  }
  return measurement;
}

function addSplitScore(measurement: Measurement, score: Score): void {
  if (measurement.preIndent === -1 && measurement.preBlank === 0)
    score.penalty += START_OF_FILE_PENALTY;
  if (measurement.endOfFile) score.penalty += END_OF_FILE_PENALTY;

  const postBlank = measurement.indent === -1 ? 1 + measurement.postBlank : 0;
  const totalBlank = measurement.preBlank + postBlank;
  score.penalty += TOTAL_BLANK_WEIGHT * totalBlank;
  score.penalty += POST_BLANK_WEIGHT * postBlank;

  const indent = measurement.indent !== -1 ? measurement.indent : measurement.postIndent;
  const anyBlanks = totalBlank !== 0;
  score.effectiveIndent += indent;

  if (indent === -1 || measurement.preIndent === -1 || indent === measurement.preIndent) return;
  if (indent > measurement.preIndent) {
    score.penalty += anyBlanks ? RELATIVE_INDENT_WITH_BLANK_PENALTY : RELATIVE_INDENT_PENALTY;
    return;
  }
  if (measurement.postIndent !== -1 && measurement.postIndent > indent) {
    score.penalty += anyBlanks ? RELATIVE_OUTDENT_WITH_BLANK_PENALTY : RELATIVE_OUTDENT_PENALTY;
    return;
  }
  score.penalty += anyBlanks ? RELATIVE_DEDENT_WITH_BLANK_PENALTY : RELATIVE_DEDENT_PENALTY;
}

function compareScores(left: Score, right: Score): number {
  const indents =
    (left.effectiveIndent > right.effectiveIndent ? 1 : 0) -
    (left.effectiveIndent < right.effectiveIndent ? 1 : 0);
  return INDENT_WEIGHT * indents + (left.penalty - right.penalty);
}

/** `xdl_build_script`: walk backwards collecting the marked runs. */
export function buildScript(
  left: Side,
  right: Side,
  maxChanges: number | undefined,
): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  let i1 = left.lines.length;
  let i2 = right.lines.length;
  while (i1 >= 0 || i2 >= 0) {
    if (left.changed.get(i1 - 1) || right.changed.get(i2 - 1)) {
      if (maxChanges !== undefined && groups.length >= maxChanges) {
        throw new GitError("E2BIG", `xdiff change list exceeds ${maxChanges}`);
      }
      const end1 = i1;
      const end2 = i2;
      while (left.changed.get(i1 - 1)) i1--;
      while (right.changed.get(i2 - 1)) i2--;
      groups.push({ oldStart: i1, oldCount: end1 - i1, newStart: i2, newCount: end2 - i2 });
    }
    i1--;
    i2--;
  }
  return groups.reverse();
}
