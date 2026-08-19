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

/** One contiguous run of changed lines, as `xdl_build_script` emits it. */
export interface ChangeGroup {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const KPDIS_RUN = 4;
const MAX_EQLIMIT = 1024;
const SIMSCAN_WINDOW = 100;
const MAX_COST_MIN = 256;
const HEUR_MIN_COST = 256;
const SNAKE_CNT = 20;
const K_HEUR = 4;
const LINE_MAX = Number.MAX_SAFE_INTEGER;

const DISCARD = 0;
const KEEP = 1;
const INVESTIGATE = 2;

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

/** git's shift-based integer square root, which sets the match limits. */
function bogosqrt(value: number): number {
  let result = 1;
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 4)) result *= 2;
  return result;
}

/**
 * The changed-line flags. Indices -1 and `length` are always false, which
 * is the sentinel the group walkers rely on instead of bounds checks.
 */
class Marks {
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
interface Side {
  lines: string[];
  /** Equality class of each line: two lines match iff their classes do. */
  classes: number[];
  changed: Marks;
  /** Indices of the lines Myers actually runs over. */
  reference: number[];
  dstart: number;
  dend: number;
}

/** A k-vector over diagonals, which run negative as well as positive. */
class Diagonals {
  readonly #values: Float64Array;
  readonly #offset: number;

  constructor(size: number, offset: number) {
    this.#values = new Float64Array(size);
    this.#offset = offset;
  }

  get(diagonal: number): number {
    return this.#values[diagonal + this.#offset]!;
  }

  set(diagonal: number, value: number): void {
    this.#values[diagonal + this.#offset] = value;
  }
}

interface Environment {
  maxCost: number;
  snakeCount: number;
  heuristicMinimum: number;
}

interface Split {
  i1: number;
  i2: number;
  minimalLow: boolean;
  minimalHigh: boolean;
}

export interface DiffLinesOptions {
  /** Turn off git's indent heuristic. On by default, as in git. */
  indentHeuristic?: boolean;
}

export function diffLines(
  oldLines: string[],
  newLines: string[],
  options: DiffLinesOptions = {},
): ChangeGroup[] {
  const { oldClasses, newClasses, inOld, inNew } = classify(oldLines, newLines);
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
  return buildScript(left, right);
}

/** Give every distinct line an id, and count its occurrences on each side. */
function classify(
  oldLines: string[],
  newLines: string[],
): { oldClasses: number[]; newClasses: number[]; inOld: number[]; inNew: number[] } {
  const ids = new Map<string, number>();
  const inOld: number[] = [];
  const inNew: number[] = [];
  const idFor = (line: string): number => {
    const existing = ids.get(line);
    if (existing !== undefined) return existing;
    const id = inOld.length;
    ids.set(line, id);
    inOld.push(0);
    inNew.push(0);
    return id;
  };
  const oldClasses = oldLines.map((line) => {
    const id = idFor(line);
    inOld[id] = (inOld[id] ?? 0) + 1;
    return id;
  });
  const newClasses = newLines.map((line) => {
    const id = idFor(line);
    inNew[id] = (inNew[id] ?? 0) + 1;
    return id;
  });
  return { oldClasses, newClasses, inOld, inNew };
}

/** Narrow the problem to the region between the common head and tail. */
function trimEnds(left: Side, right: Side): void {
  const limit = Math.min(left.lines.length, right.lines.length);
  let index = 0;
  while (index < limit && left.classes[index] === right.classes[index]) index++;
  left.dstart = index;
  right.dstart = index;

  const tail = limit - index;
  let back = 0;
  while (
    back < tail &&
    left.classes[left.lines.length - 1 - back] === right.classes[right.lines.length - 1 - back]
  ) {
    back++;
  }
  left.dend = left.lines.length - back - 1;
  right.dend = right.lines.length - back - 1;
}

/**
 * Drop lines that cannot possibly match, so Myers runs over a smaller and
 * far more deterministic problem. A line with no counterpart at all is
 * changed by definition; one that repeats more often than the match limit
 * is dropped only when it sits inside a run of such lines.
 */
function cleanupRecords(left: Side, right: Side, inRight: number[], inLeft: number[]): void {
  const offset = left.dstart;
  const leftLength = left.dend - offset + 1;
  const rightLength = right.dend - offset + 1;
  const leftActions = actionsFor(left, offset, leftLength, inRight);
  const rightActions = actionsFor(right, offset, rightLength, inLeft);
  applyActions(left, offset, leftActions);
  applyActions(right, offset, rightActions);
}

function actionsFor(side: Side, offset: number, length: number, other: number[]): Uint8Array {
  const actions = new Uint8Array(Math.max(length, 0));
  const limit = Math.min(bogosqrt(side.lines.length), MAX_EQLIMIT);
  for (let i = 0; i < length; i++) {
    const matches = other[side.classes[i + offset]!] ?? 0;
    actions[i] = matches === 0 ? DISCARD : matches < limit ? KEEP : INVESTIGATE;
  }
  return actions;
}

function applyActions(side: Side, offset: number, actions: Uint8Array): void {
  side.reference = [];
  for (let i = 0; i < actions.length; i++) {
    let action = actions[i]!;
    if (action === INVESTIGATE) action = isMultiMatchNoise(actions, i) ? DISCARD : KEEP;
    if (action === KEEP) side.reference.push(i + offset);
    else side.changed.set(i + offset, true);
  }
}

/** `xdl_clean_mmatch`: is this repeated line surrounded by unmatched ones? */
function isMultiMatchNoise(actions: Uint8Array, index: number): boolean {
  const first = Math.max(0, index - SIMSCAN_WINDOW);
  const last = Math.min(actions.length - 1, index + SIMSCAN_WINDOW);

  let unmatchedBefore = 0;
  let repeatedBefore = 1;
  for (let step = 1; index - step >= first; step++) {
    const action = actions[index - step]!;
    if (action === DISCARD) unmatchedBefore++;
    else if (action === INVESTIGATE) repeatedBefore++;
    else break;
  }
  if (unmatchedBefore === 0) return false;

  let unmatchedAfter = 0;
  let repeatedAfter = 1;
  for (let step = 1; index + step <= last; step++) {
    const action = actions[index + step]!;
    if (action === DISCARD) unmatchedAfter++;
    else if (action === INVESTIGATE) repeatedAfter++;
    else break;
  }
  if (unmatchedAfter === 0) return false;

  const unmatched = unmatchedAfter + unmatchedBefore;
  const repeated = repeatedAfter + repeatedBefore;
  return repeated * KPDIS_RUN < repeated + unmatched;
}

function hashAt(side: Side, index: number): number {
  return side.classes[side.reference[index]!]!;
}

/** `xdl_recs_cmp`: divide the box at a middle snake and recurse. */
function compare(
  left: Side,
  off1: number,
  lim1: number,
  right: Side,
  off2: number,
  lim2: number,
  forward: Diagonals,
  backward: Diagonals,
  needMinimal: boolean,
  environment: Environment,
): void {
  let low1 = off1;
  let low2 = off2;
  let high1 = lim1;
  let high2 = lim2;
  while (low1 < high1 && low2 < high2 && hashAt(left, low1) === hashAt(right, low2)) {
    low1++;
    low2++;
  }
  while (low1 < high1 && low2 < high2 && hashAt(left, high1 - 1) === hashAt(right, high2 - 1)) {
    high1--;
    high2--;
  }

  if (low1 === high1) {
    for (; low2 < high2; low2++) right.changed.set(right.reference[low2]!, true);
    return;
  }
  if (low2 === high2) {
    for (; low1 < high1; low1++) left.changed.set(left.reference[low1]!, true);
    return;
  }

  const split = findSplit(
    left,
    low1,
    high1,
    right,
    low2,
    high2,
    forward,
    backward,
    needMinimal,
    environment,
  );
  compare(
    left,
    low1,
    split.i1,
    right,
    low2,
    split.i2,
    forward,
    backward,
    split.minimalLow,
    environment,
  );
  compare(
    left,
    split.i1,
    high1,
    right,
    split.i2,
    high2,
    forward,
    backward,
    split.minimalHigh,
    environment,
  );
}

/** `xdl_split`: the bidirectional Myers scan, with git's cost heuristics. */
function findSplit(
  left: Side,
  off1: number,
  lim1: number,
  right: Side,
  off2: number,
  lim2: number,
  forward: Diagonals,
  backward: Diagonals,
  needMinimal: boolean,
  environment: Environment,
): Split {
  const dmin = off1 - lim2;
  const dmax = lim1 - off2;
  const forwardMid = off1 - off2;
  const backwardMid = lim1 - lim2;
  const odd = ((forwardMid - backwardMid) & 1) === 1;
  let forwardMin = forwardMid;
  let forwardMax = forwardMid;
  let backwardMin = backwardMid;
  let backwardMax = backwardMid;

  forward.set(forwardMid, off1);
  backward.set(backwardMid, lim1);

  for (let cost = 1; ; cost++) {
    let sawSnake = false;

    if (forwardMin > dmin) forward.set(--forwardMin - 1, -1);
    else forwardMin++;
    if (forwardMax < dmax) forward.set(++forwardMax + 1, -1);
    else forwardMax--;

    for (let d = forwardMax; d >= forwardMin; d -= 2) {
      let i1 =
        forward.get(d - 1) >= forward.get(d + 1) ? forward.get(d - 1) + 1 : forward.get(d + 1);
      const previous = i1;
      let i2 = i1 - d;
      while (i1 < lim1 && i2 < lim2 && hashAt(left, i1) === hashAt(right, i2)) {
        i1++;
        i2++;
      }
      if (i1 - previous > environment.snakeCount) sawSnake = true;
      forward.set(d, i1);
      if (odd && backwardMin <= d && d <= backwardMax && backward.get(d) <= i1) {
        return { i1, i2, minimalLow: true, minimalHigh: true };
      }
    }

    if (backwardMin > dmin) backward.set(--backwardMin - 1, LINE_MAX);
    else backwardMin++;
    if (backwardMax < dmax) backward.set(++backwardMax + 1, LINE_MAX);
    else backwardMax--;

    for (let d = backwardMax; d >= backwardMin; d -= 2) {
      let i1 =
        backward.get(d - 1) < backward.get(d + 1) ? backward.get(d - 1) : backward.get(d + 1) - 1;
      const previous = i1;
      let i2 = i1 - d;
      while (i1 > off1 && i2 > off2 && hashAt(left, i1 - 1) === hashAt(right, i2 - 1)) {
        i1--;
        i2--;
      }
      if (previous - i1 > environment.snakeCount) sawSnake = true;
      backward.set(d, i1);
      if (!odd && forwardMin <= d && d <= forwardMax && i1 <= forward.get(d)) {
        return { i1, i2, minimalLow: true, minimalHigh: true };
      }
    }

    if (needMinimal) continue;

    // Past a certain cost a long enough snake is good enough: take it and
    // stop paying for minimality.
    if (sawSnake && cost > environment.heuristicMinimum) {
      let best = 0;
      let candidate: Split | null = null;
      for (let d = forwardMax; d >= forwardMin; d -= 2) {
        const distance = d > forwardMid ? d - forwardMid : forwardMid - d;
        const i1 = forward.get(d);
        const i2 = i1 - d;
        const reach = i1 - off1 + (i2 - off2) - distance;
        if (
          reach > K_HEUR * cost &&
          reach > best &&
          off1 + environment.snakeCount <= i1 &&
          i1 < lim1 &&
          off2 + environment.snakeCount <= i2 &&
          i2 < lim2
        ) {
          for (let k = 1; hashAt(left, i1 - k) === hashAt(right, i2 - k); k++) {
            if (k === environment.snakeCount) {
              best = reach;
              candidate = { i1, i2, minimalLow: true, minimalHigh: false };
              break;
            }
          }
        }
      }
      if (candidate !== null) return candidate;

      best = 0;
      for (let d = backwardMax; d >= backwardMin; d -= 2) {
        const distance = d > backwardMid ? d - backwardMid : backwardMid - d;
        const i1 = backward.get(d);
        const i2 = i1 - d;
        const reach = lim1 - i1 + (lim2 - i2) - distance;
        if (
          reach > K_HEUR * cost &&
          reach > best &&
          off1 < i1 &&
          i1 <= lim1 - environment.snakeCount &&
          off2 < i2 &&
          i2 <= lim2 - environment.snakeCount
        ) {
          for (let k = 0; hashAt(left, i1 + k) === hashAt(right, i2 + k); k++) {
            if (k === environment.snakeCount - 1) {
              best = reach;
              candidate = { i1, i2, minimalLow: false, minimalHigh: true };
              break;
            }
          }
        }
      }
      if (candidate !== null) return candidate;
    }

    // Enough is enough: take the furthest reaching path from either side.
    if (cost >= environment.maxCost) {
      let forwardBest = -1;
      let forwardBest1 = -1;
      for (let d = forwardMax; d >= forwardMin; d -= 2) {
        let i1 = Math.min(forward.get(d), lim1);
        let i2 = i1 - d;
        if (lim2 < i2) {
          i1 = lim2 + d;
          i2 = lim2;
        }
        if (forwardBest < i1 + i2) {
          forwardBest = i1 + i2;
          forwardBest1 = i1;
        }
      }

      let backwardBest = LINE_MAX;
      let backwardBest1 = LINE_MAX;
      for (let d = backwardMax; d >= backwardMin; d -= 2) {
        let i1 = Math.max(off1, backward.get(d));
        let i2 = i1 - d;
        if (i2 < off2) {
          i1 = off2 + d;
          i2 = off2;
        }
        if (i1 + i2 < backwardBest) {
          backwardBest = i1 + i2;
          backwardBest1 = i1;
        }
      }

      if (lim1 + lim2 - backwardBest < forwardBest - (off1 + off2)) {
        return {
          i1: forwardBest1,
          i2: forwardBest - forwardBest1,
          minimalLow: true,
          minimalHigh: false,
        };
      }
      return {
        i1: backwardBest1,
        i2: backwardBest - backwardBest1,
        minimalLow: false,
        minimalHigh: true,
      };
    }
  }
}

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
function compact(side: Side, other: Side, indentHeuristic: boolean): void {
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
function indentOf(line: string): number {
  let indent = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === " ") indent += 1;
    else if (char === "\t") indent += 8 - (indent % 8);
    else if (!isSpace(char)) return indent;
    if (indent >= MAX_INDENT) return MAX_INDENT;
  }
  return -1;
}

function isSpace(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\v" ||
    char === "\f" ||
    char === "\r"
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
function buildScript(left: Side, right: Side): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  let i1 = left.lines.length;
  let i2 = right.lines.length;
  while (i1 >= 0 || i2 >= 0) {
    if (left.changed.get(i1 - 1) || right.changed.get(i2 - 1)) {
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
