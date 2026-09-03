// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from Git's xdiff/xmerge.c at 94f057755b7941b321fd11fec1b2e3ca5313a4e0
// (v2.54.0). LibXDiff is Copyright (C) 2003-2006 Davide Libenzi and
// Johannes E. Schindelin. LGPL-2.1-or-later, like the original.

import { type ByteRecord, byteRecordsEqual, type ChangeGroup, diffByteRecords } from "./myers.js";
import { tooBig } from "./xmerge-helpers.js";
import type { MergeRegion } from "./xmerge-types.js";

export function buildMergeRegions(
  current: ChangeGroup[],
  incoming: ChangeGroup[],
  currentLines: ByteRecord[],
  incomingLines: ByteRecord[],
  baseLineCount: number,
  currentLineCount: number,
  incomingLineCount: number,
  maxConflicts: number,
): MergeRegion[] {
  const regions: MergeRegion[] = [];
  let conflicts = 0;
  let currentIndex = 0;
  let incomingIndex = 0;
  while (currentIndex < current.length && incomingIndex < incoming.length) {
    const left = current[currentIndex]!;
    const right = incoming[incomingIndex]!;
    if (left.oldStart + left.oldCount < right.oldStart) {
      conflicts = appendRegion(regions, conflicts, maxConflicts, {
        mode: 1,
        baseStart: left.oldStart,
        baseCount: left.oldCount,
        currentStart: left.newStart,
        currentCount: left.newCount,
        incomingStart: right.newStart - right.oldStart + left.oldStart,
        incomingCount: left.oldCount,
      });
      currentIndex++;
      continue;
    }
    if (right.oldStart + right.oldCount < left.oldStart) {
      conflicts = appendRegion(regions, conflicts, maxConflicts, {
        mode: 2,
        baseStart: right.oldStart,
        baseCount: right.oldCount,
        currentStart: left.newStart - left.oldStart + right.oldStart,
        currentCount: right.oldCount,
        incomingStart: right.newStart,
        incomingCount: right.newCount,
      });
      incomingIndex++;
      continue;
    }
    if (!sameChange(left, right, currentLines, incomingLines)) {
      conflicts = appendRegion(regions, conflicts, maxConflicts, overlapRegion(left, right));
    }
    const leftEnd = left.oldStart + left.oldCount;
    const rightEnd = right.oldStart + right.oldCount;
    if (leftEnd >= rightEnd) incomingIndex++;
    if (rightEnd >= leftEnd) currentIndex++;
  }
  for (; currentIndex < current.length; currentIndex++) {
    const change = current[currentIndex]!;
    conflicts = appendRegion(regions, conflicts, maxConflicts, {
      mode: 1,
      baseStart: change.oldStart,
      baseCount: change.oldCount,
      currentStart: change.newStart,
      currentCount: change.newCount,
      incomingStart: change.oldStart + incomingLineCount - baseLineCount,
      incomingCount: change.oldCount,
    });
  }
  for (; incomingIndex < incoming.length; incomingIndex++) {
    const change = incoming[incomingIndex]!;
    conflicts = appendRegion(regions, conflicts, maxConflicts, {
      mode: 2,
      baseStart: change.oldStart,
      baseCount: change.oldCount,
      currentStart: change.oldStart + currentLineCount - baseLineCount,
      currentCount: change.oldCount,
      incomingStart: change.newStart,
      incomingCount: change.newCount,
    });
  }
  return regions;
}

function sameChange(
  left: ChangeGroup,
  right: ChangeGroup,
  current: ByteRecord[],
  incoming: ByteRecord[],
): boolean {
  if (
    left.oldStart !== right.oldStart ||
    left.oldCount !== right.oldCount ||
    left.newCount !== right.newCount
  ) {
    return false;
  }
  for (let index = 0; index < left.newCount; index++) {
    if (!byteRecordsEqual(current[left.newStart + index]!, incoming[right.newStart + index]!)) {
      return false;
    }
  }
  return true;
}

function overlapRegion(left: ChangeGroup, right: ChangeGroup): MergeRegion {
  const offset = left.oldStart - right.oldStart;
  const finalOffset = offset + left.oldCount - right.oldCount;
  let baseStart = left.oldStart;
  let currentStart = left.newStart;
  let incomingStart = right.newStart;
  if (offset > 0) {
    baseStart -= offset;
    currentStart -= offset;
  } else {
    incomingStart += offset;
  }
  let baseCount = left.oldStart + left.oldCount - baseStart;
  let currentCount = left.newStart + left.newCount - currentStart;
  let incomingCount = right.newStart + right.newCount - incomingStart;
  if (finalOffset < 0) {
    baseCount -= finalOffset;
    currentCount -= finalOffset;
  } else {
    incomingCount += finalOffset;
  }
  return {
    mode: 0,
    baseStart,
    baseCount,
    currentStart,
    currentCount,
    incomingStart,
    incomingCount,
  };
}

function appendRegion(
  regions: MergeRegion[],
  conflicts: number,
  maxConflicts: number,
  region: MergeRegion,
): number {
  const previous = regions[regions.length - 1];
  if (
    previous !== undefined &&
    (region.currentStart <= previous.currentStart + previous.currentCount ||
      region.incomingStart <= previous.incomingStart + previous.incomingCount)
  ) {
    if (region.mode !== previous.mode && previous.mode !== 0) {
      if (conflicts >= maxConflicts) throw tooBig("text merge conflict count", maxConflicts);
      previous.mode = 0;
      conflicts++;
    }
    previous.baseCount = region.baseStart + region.baseCount - previous.baseStart;
    previous.currentCount = region.currentStart + region.currentCount - previous.currentStart;
    previous.incomingCount = region.incomingStart + region.incomingCount - previous.incomingStart;
    return conflicts;
  }
  if (region.mode === 0) {
    if (conflicts >= maxConflicts) throw tooBig("text merge conflict count", maxConflicts);
    conflicts++;
  }
  regions.push(region);
  return conflicts;
}

export function refineConflicts(
  regions: MergeRegion[],
  current: ByteRecord[],
  incoming: ByteRecord[],
  maxChanges: number,
  maxConflicts: number,
  indentHeuristic: boolean,
): MergeRegion[] {
  const refined: MergeRegion[] = [];
  let conflicts = 0;
  for (const region of regions) {
    if (region.mode !== 0 || region.currentCount === 0 || region.incomingCount === 0) {
      if (refined.length >= maxChanges) {
        throw tooBig("text merge refined change list", maxChanges);
      }
      if (region.mode === 0) {
        if (conflicts >= maxConflicts) throw tooBig("text merge conflict count", maxConflicts);
        conflicts++;
      }
      refined.push(region);
      continue;
    }
    const changes = diffByteRecords(
      current.slice(region.currentStart, region.currentStart + region.currentCount),
      incoming.slice(region.incomingStart, region.incomingStart + region.incomingCount),
      {
        indentHeuristic,
        maxChanges: Math.min(maxChanges - refined.length, maxConflicts - conflicts),
      },
    );
    if (refined.length + changes.length > maxChanges) {
      throw tooBig("text merge refined change list", maxChanges);
    }
    if (changes.length === 0) {
      if (refined.length >= maxChanges) {
        throw tooBig("text merge refined change list", maxChanges);
      }
      refined.push({ ...region, mode: 4 });
      continue;
    }
    for (const change of changes) {
      if (conflicts >= maxConflicts) throw tooBig("text merge conflict count", maxConflicts);
      refined.push({
        mode: 0,
        baseStart: region.baseStart,
        baseCount: region.baseCount,
        currentStart: region.currentStart + change.oldStart,
        currentCount: change.oldCount,
        incomingStart: region.incomingStart + change.newStart,
        incomingCount: change.newCount,
      });
      conflicts++;
    }
  }
  return refined;
}

export function simplifyConflicts(
  regions: MergeRegion[],
  current: ByteRecord[],
  simplifyIfNoAlnum: boolean,
): MergeRegion[] {
  const simplified: MergeRegion[] = [];
  for (const region of regions) {
    const previous = simplified[simplified.length - 1];
    if (previous === undefined || previous.mode !== 0 || region.mode !== 0) {
      simplified.push(region);
      continue;
    }
    const begin = previous.currentStart + previous.currentCount;
    const end = region.currentStart;
    const keepSeparate =
      end - begin > 3 &&
      (!simplifyIfNoAlnum || linesContainAsciiAlnum(current, begin, end - begin));
    if (keepSeparate) {
      simplified.push(region);
      continue;
    }
    previous.currentCount = region.currentStart + region.currentCount - previous.currentStart;
    previous.incomingCount = region.incomingStart + region.incomingCount - previous.incomingStart;
  }
  return simplified;
}

function linesContainAsciiAlnum(lines: ByteRecord[], start: number, count: number): boolean {
  for (let line = start; line < start + count; line++) {
    const record = lines[line]!;
    for (let index = record.start; index < record.end; index++) {
      const byte = record.bytes[index]!;
      if (
        (byte >= 0x30 && byte <= 0x39) ||
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function refineZdiff3(
  regions: MergeRegion[],
  current: ByteRecord[],
  incoming: ByteRecord[],
): void {
  for (const region of regions) {
    if (region.mode !== 0) continue;
    while (
      region.currentCount > 0 &&
      region.incomingCount > 0 &&
      byteRecordsEqual(current[region.currentStart]!, incoming[region.incomingStart]!)
    ) {
      region.currentStart++;
      region.incomingStart++;
      region.currentCount--;
      region.incomingCount--;
    }
    while (
      region.currentCount > 0 &&
      region.incomingCount > 0 &&
      byteRecordsEqual(
        current[region.currentStart + region.currentCount - 1]!,
        incoming[region.incomingStart + region.incomingCount - 1]!,
      )
    ) {
      region.currentCount--;
      region.incomingCount--;
    }
  }
}
