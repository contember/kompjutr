// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from the xdiff library as it appears in git, which derives from
// LibXDiff, Copyright (C) 2003 Davide Libenzi <davidel@xmailserver.org>.
// LGPL-2.1-or-later, like the original. See ./LICENSE — this directory is
// the one part of kompjutr that is not MIT.

import type { ByteRecord, Side } from "./myers-state.js";

const KPDIS_RUN = 4;
const MAX_EQLIMIT = 1024;
const SIMSCAN_WINDOW = 100;
const DISCARD = 0;
const KEEP = 1;
const INVESTIGATE = 2;

/** git's shift-based integer square root, which sets the match limits. */
export function bogosqrt(value: number): number {
  let result = 1;
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 4)) result *= 2;
  return result;
}

export function classifyBytes(
  oldLines: ByteRecord[],
  newLines: ByteRecord[],
): { oldClasses: number[]; newClasses: number[]; inOld: number[]; inNew: number[] } {
  const buckets = new Map<string, number[]>();
  const representatives: ByteRecord[] = [];
  const inOld: number[] = [];
  const inNew: number[] = [];
  const idFor = (line: ByteRecord): number => {
    const key = byteRecordHash(line);
    const bucket = buckets.get(key);
    if (bucket !== undefined) {
      for (const id of bucket) {
        if (byteRecordsEqual(representatives[id]!, line)) return id;
      }
    }
    const id = representatives.length;
    representatives.push(line);
    inOld.push(0);
    inNew.push(0);
    if (bucket === undefined) buckets.set(key, [id]);
    else bucket.push(id);
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

function byteRecordHash(record: ByteRecord): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = record.start; index < record.end; index++) {
    const byte = record.bytes[index]!;
    left = Math.imul(left ^ byte, 0x01000193) >>> 0;
    right = Math.imul(right ^ byte, 0x85ebca6b) >>> 0;
  }
  return `${record.end - record.start}:${left}:${right}`;
}

export function byteRecordsEqual(left: ByteRecord, right: ByteRecord): boolean {
  const length = left.end - left.start;
  if (right.end - right.start !== length) return false;
  for (let index = 0; index < length; index++) {
    if (left.bytes[left.start + index] !== right.bytes[right.start + index]) return false;
  }
  return true;
}

/** Give every distinct line an id, and count its occurrences on each side. */
export function classify(
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
export function trimEnds(left: Side, right: Side): void {
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
export function cleanupRecords(left: Side, right: Side, inRight: number[], inLeft: number[]): void {
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
