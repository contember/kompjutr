// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from Git's xdiff/xmerge.c at 94f057755b7941b321fd11fec1b2e3ca5313a4e0
// (v2.54.0). LibXDiff is Copyright (C) 2003-2006 Davide Libenzi and
// Johannes E. Schindelin. LGPL-2.1-or-later, like the original.

import type { ByteRecord } from "./myers.js";
import { addSize, checkedSum, tooBig } from "./xmerge-helpers.js";
import type { MergeRegion, ResolvedOptions } from "./xmerge-types.js";

export function validateConflictRegions(
  regions: MergeRegion[],
  base: ByteRecord[],
  current: ByteRecord[],
  incoming: ByteRecord[],
  options: ResolvedOptions,
): void {
  for (const region of regions) {
    if (region.mode !== 0) continue;
    let bytes = recordsLength(current, region.currentStart, region.currentCount);
    bytes = checkedSum(
      [bytes, recordsLength(incoming, region.incomingStart, region.incomingCount)],
      "conflict region",
    );
    if (options.style !== "merge") {
      bytes = checkedSum(
        [bytes, recordsLength(base, region.baseStart, region.baseCount)],
        "conflict region",
      );
    }
    if (bytes > options.limits.maxConflictBytes) {
      throw tooBig("text merge conflict region", options.limits.maxConflictBytes);
    }
  }
}

export function fillMerge(
  output: Uint8Array | null,
  regions: MergeRegion[],
  base: ByteRecord[],
  current: ByteRecord[],
  incoming: ByteRecord[],
  options: ResolvedOptions,
): number {
  let size = 0;
  let currentLine = 0;
  for (const region of regions) {
    if (region.mode === 4) continue;
    const needsCr = isCrNeeded(current, incoming, base, region);
    size = copyRecords(
      output,
      size,
      current,
      currentLine,
      region.currentStart - currentLine,
      false,
      false,
      options,
    );
    if (region.mode === 0) {
      size = writeMarker(output, size, 0x3c, options.labels.current, needsCr, options);
      size = copyRecords(
        output,
        size,
        current,
        region.currentStart,
        region.currentCount,
        needsCr,
        true,
        options,
      );
      if (options.style !== "merge") {
        size = writeMarker(output, size, 0x7c, options.labels.base, needsCr, options);
        size = copyRecords(
          output,
          size,
          base,
          region.baseStart,
          region.baseCount,
          needsCr,
          true,
          options,
        );
      }
      size = writeMarker(output, size, 0x3d, null, needsCr, options);
      size = copyRecords(
        output,
        size,
        incoming,
        region.incomingStart,
        region.incomingCount,
        needsCr,
        true,
        options,
      );
      size = writeMarker(output, size, 0x3e, options.labels.incoming, needsCr, options);
    } else {
      if ((region.mode & 1) !== 0) {
        size = copyRecords(
          output,
          size,
          current,
          region.currentStart,
          region.currentCount,
          needsCr,
          (region.mode & 2) !== 0,
          options,
        );
      }
      if ((region.mode & 2) !== 0) {
        size = copyRecords(
          output,
          size,
          incoming,
          region.incomingStart,
          region.incomingCount,
          false,
          false,
          options,
        );
      }
    }
    currentLine = region.currentStart + region.currentCount;
  }
  return copyRecords(
    output,
    size,
    current,
    currentLine,
    current.length - currentLine,
    false,
    false,
    options,
  );
}

function copyRecords(
  output: Uint8Array | null,
  size: number,
  records: ByteRecord[],
  start: number,
  count: number,
  needsCr: boolean,
  addNewline: boolean,
  options: ResolvedOptions,
): number {
  for (let index = start; index < start + count; index++) {
    const record = records[index]!;
    const length = record.end - record.start;
    const next = addSize(size, length, options.limits.maxOutputBytes);
    if (output !== null) output.set(record.bytes.subarray(record.start, record.end), size);
    size = next;
  }
  if (addNewline && count > 0) {
    const record = records[start + count - 1]!;
    if (record.end === record.start || record.bytes[record.end - 1] !== 0x0a) {
      if (needsCr) size = writeByte(output, size, 0x0d, options);
      size = writeByte(output, size, 0x0a, options);
    }
  }
  return size;
}

function writeMarker(
  output: Uint8Array | null,
  size: number,
  marker: number,
  label: Uint8Array | null,
  needsCr: boolean,
  options: ResolvedOptions,
): number {
  const markerEnd = addSize(size, options.markerSize, options.limits.maxOutputBytes);
  if (output !== null) output.fill(marker, size, markerEnd);
  size = markerEnd;
  if (label !== null) {
    size = writeByte(output, size, 0x20, options);
    const labelEnd = addSize(size, label.length, options.limits.maxOutputBytes);
    if (output !== null) output.set(label, size);
    size = labelEnd;
  }
  if (needsCr) size = writeByte(output, size, 0x0d, options);
  return writeByte(output, size, 0x0a, options);
}

function writeByte(
  output: Uint8Array | null,
  size: number,
  byte: number,
  options: ResolvedOptions,
): number {
  const next = addSize(size, 1, options.limits.maxOutputBytes);
  if (output !== null) output[size] = byte;
  return next;
}

function isCrNeeded(
  current: ByteRecord[],
  incoming: ByteRecord[],
  base: ByteRecord[],
  region: MergeRegion,
): boolean {
  let needsCr = isEolCrlf(current, region.currentStart > 0 ? region.currentStart - 1 : 0);
  if (needsCr !== 0) {
    needsCr = isEolCrlf(incoming, region.incomingStart > 0 ? region.incomingStart - 1 : 0);
  }
  if (needsCr !== 0) needsCr = isEolCrlf(base, 0);
  return needsCr > 0;
}

function isEolCrlf(records: ByteRecord[], index: number): number {
  if (index < records.length - 1) return recordEndsCrlf(records[index]!) ? 1 : 0;
  if (records.length === 0) return -1;
  const record = records[index]!;
  if (record.end > record.start && record.bytes[record.end - 1] === 0x0a) {
    return recordEndsCrlf(record) ? 1 : 0;
  }
  if (index === 0) return -1;
  return recordEndsCrlf(records[index - 1]!) ? 1 : 0;
}

function recordEndsCrlf(record: ByteRecord): boolean {
  return record.end - record.start > 1 && record.bytes[record.end - 2] === 0x0d;
}

function recordsLength(records: ByteRecord[], start: number, count: number): number {
  let length = 0;
  for (let index = start; index < start + count; index++) {
    const record = records[index]!;
    length = checkedSum([length, record.end - record.start], "record bytes");
  }
  return length;
}
