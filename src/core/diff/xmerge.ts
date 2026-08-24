// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from Git's xdiff/xmerge.c at 94f057755b7941b321fd11fec1b2e3ca5313a4e0
// (v2.54.0). LibXDiff is Copyright (C) 2003-2006 Davide Libenzi and
// Johannes E. Schindelin. LGPL-2.1-or-later, like the original.

import { GitError } from "../errors.js";
import { isBinary } from "./lines.js";
import { type ByteRecord, byteRecordsEqual, type ChangeGroup, diffByteRecords } from "./myers.js";

const MIB = 1024 * 1024;
const DEFAULT_MARKER_SIZE = 7;
const LINE_RECORD_BYTES = 96;
const DIFF_LINE_BYTES = 320;
// Base-to-side scripts remain retained while refinement creates another script.
const CHANGE_BYTES = 192;
// Refinement and simplification build a new 128-byte region list while the old one is retained.
const MERGE_BYTES = 256;
const FIXED_MERGE_BYTES = 4096;

export type TextMergeStyle = "merge" | "diff3" | "zdiff3";
export type TextMergeRefinement = "eager" | "zealous" | "zealous-alnum";

export interface TextMergeLabels {
  current?: string;
  base?: string;
  incoming?: string;
}

export interface TextMergeLimits {
  maxInputBytes: number;
  maxTotalInputBytes: number;
  maxLineBytes: number;
  maxLines: number;
  maxChanges: number;
  maxConflicts: number;
  maxConflictBytes: number;
  maxLabelBytes: number;
  maxMarkerSize: number;
  maxOutputBytes: number;
  maxMemoryBytes: number;
}

export const DEFAULT_TEXT_MERGE_LIMITS: Readonly<TextMergeLimits> = Object.freeze({
  maxInputBytes: 8 * MIB,
  maxTotalInputBytes: 24 * MIB,
  maxLineBytes: 8 * MIB,
  maxLines: 200_000,
  maxChanges: 100_000,
  maxConflicts: 20_000,
  maxConflictBytes: 16 * MIB,
  maxLabelBytes: 256,
  maxMarkerSize: 64,
  maxOutputBytes: 32 * MIB,
  maxMemoryBytes: 64 * MIB,
});

export interface TextMergeOptions {
  style?: TextMergeStyle;
  refinement?: TextMergeRefinement;
  labels?: TextMergeLabels;
  markerSize?: number;
  /** Enable xdiff's indent heuristic. `git merge-file` leaves it off. */
  indentHeuristic?: boolean;
  limits?: Partial<TextMergeLimits>;
}

export interface TextMergeMemoryEstimate {
  inputBytes: number;
  lines: number;
  lineTableBytes: number;
  diffWorkspaceBytes: number;
  changeListBytes: number;
  mergeListBytes: number;
  /** Worst output allocation for this input shape, capped by `maxOutputBytes`. */
  outputBytes: number;
  /** Encoded labels and fixed option/result bookkeeping. */
  fixedBytes: number;
  peakBytes: number;
}

interface TextMergeResultBase {
  memory: TextMergeMemoryEstimate;
}

export type TextMergeResult =
  | (TextMergeResultBase & { kind: "clean"; content: Uint8Array })
  | (TextMergeResultBase & { kind: "conflict"; content: Uint8Array; conflicts: number })
  | (TextMergeResultBase & { kind: "binary" });

interface InputInfo {
  lines: number;
  maxLineBytes: number;
}

interface EncodedLabels {
  current: Uint8Array | null;
  base: Uint8Array | null;
  incoming: Uint8Array | null;
}

interface ResolvedOptions {
  style: TextMergeStyle;
  refinement: TextMergeRefinement;
  labels: EncodedLabels;
  markerSize: number;
  indentHeuristic: boolean;
  limits: TextMergeLimits;
}

interface MergeRegion {
  mode: number;
  baseStart: number;
  baseCount: number;
  currentStart: number;
  currentCount: number;
  incomingStart: number;
  incomingCount: number;
}

/**
 * Conservative reservation for the caller's three inputs, byte-line tables,
 * two xdiff workspaces, retained change/merge records, and bounded output.
 */
export function estimateTextMergeMemory(
  base: Uint8Array,
  current: Uint8Array,
  incoming: Uint8Array,
  options: TextMergeOptions = {},
): TextMergeMemoryEstimate {
  const resolved = resolveOptions(options);
  return estimateResolvedTextMergeMemory(base, current, incoming, resolved);
}

function estimateResolvedTextMergeMemory(
  base: Uint8Array,
  current: Uint8Array,
  incoming: Uint8Array,
  resolved: ResolvedOptions,
): TextMergeMemoryEstimate {
  const infos = validateAndScanInputs(base, current, incoming, resolved.limits);
  const inputBytes = checkedSum([base.length, current.length, incoming.length], "input");
  if (isBinary(base) || isBinary(current) || isBinary(incoming)) {
    return memoryEstimate(inputBytes, 0, 0, 0, 0, 0, resolved);
  }
  const identity = identityMergeContent(base, current, incoming);
  if (identity !== null) {
    if (identity.length > resolved.limits.maxOutputBytes) {
      throw tooBig("text merge output", resolved.limits.maxOutputBytes);
    }
    return memoryEstimate(inputBytes, 0, 0, 0, 0, 0, resolved);
  }

  const lines = checkedSum(
    infos.map((info) => info.lines),
    "line count",
  );
  const leftDiffLines = infos[0]!.lines + infos[1]!.lines;
  const rightDiffLines = infos[0]!.lines + infos[2]!.lines;
  const refinementDiffLines = infos[1]!.lines + infos[2]!.lines;
  const potentialChanges = Math.min(resolved.limits.maxChanges, leftDiffLines + rightDiffLines + 2);
  const potentialMerges = potentialChanges;
  const potentialConflicts = Math.min(resolved.limits.maxConflicts, potentialMerges);
  const labels =
    byteLength(resolved.labels.current) +
    byteLength(resolved.labels.base) +
    byteLength(resolved.labels.incoming);
  const markerLines = resolved.style === "merge" ? 3 : 4;
  const markerOverhead = potentialConflicts * (markerLines * (resolved.markerSize + 3) + labels);
  const sourceOutput =
    current.length + incoming.length + (resolved.style === "merge" ? 0 : base.length);
  const outputBytes = Math.min(
    resolved.limits.maxOutputBytes,
    checkedSum([sourceOutput, markerOverhead, potentialConflicts * markerLines], "output estimate"),
  );
  return memoryEstimate(
    inputBytes,
    lines,
    Math.max(leftDiffLines, rightDiffLines, refinementDiffLines),
    potentialChanges,
    potentialMerges,
    outputBytes,
    resolved,
  );
}

export function mergeText(
  base: Uint8Array,
  current: Uint8Array,
  incoming: Uint8Array,
  options: TextMergeOptions = {},
): TextMergeResult {
  const resolved = resolveOptions(options);
  const memory = estimateResolvedTextMergeMemory(base, current, incoming, resolved);
  if (isBinary(base) || isBinary(current) || isBinary(incoming)) return { kind: "binary", memory };
  if (bytesEqual(current, incoming)) return { kind: "clean", content: current, memory };
  if (bytesEqual(base, current)) return { kind: "clean", content: incoming, memory };
  if (bytesEqual(base, incoming)) return { kind: "clean", content: current, memory };

  const baseLines = splitByteRecords(base);
  const currentLines = splitByteRecords(current);
  const incomingLines = splitByteRecords(incoming);
  const currentChanges = diffByteRecords(baseLines, currentLines, {
    indentHeuristic: resolved.indentHeuristic,
    maxChanges: resolved.limits.maxChanges,
  });
  const incomingChanges = diffByteRecords(baseLines, incomingLines, {
    indentHeuristic: resolved.indentHeuristic,
    maxChanges: resolved.limits.maxChanges - currentChanges.length,
  });
  if (currentChanges.length + incomingChanges.length > resolved.limits.maxChanges) {
    throw tooBig("text merge change list", resolved.limits.maxChanges);
  }

  let regions = buildMergeRegions(
    currentChanges,
    incomingChanges,
    currentLines,
    incomingLines,
    baseLines.length,
    currentLines.length,
    incomingLines.length,
    resolved.limits.maxConflicts,
  );
  if (resolved.style === "zdiff3") {
    refineZdiff3(regions, currentLines, incomingLines);
  } else if (resolved.style === "merge" && resolved.refinement !== "eager") {
    regions = refineConflicts(
      regions,
      currentLines,
      incomingLines,
      resolved.limits.maxChanges,
      resolved.limits.maxConflicts,
      resolved.indentHeuristic,
    );
    regions = simplifyConflicts(regions, currentLines, resolved.refinement === "zealous-alnum");
  }

  const conflicts = regions.reduce((count, region) => count + (region.mode === 0 ? 1 : 0), 0);
  if (conflicts > resolved.limits.maxConflicts) {
    throw tooBig("text merge conflict count", resolved.limits.maxConflicts);
  }
  validateConflictRegions(regions, baseLines, currentLines, incomingLines, resolved);
  const size = fillMerge(null, regions, baseLines, currentLines, incomingLines, resolved);
  const content = new Uint8Array(size);
  const written = fillMerge(content, regions, baseLines, currentLines, incomingLines, resolved);
  if (written !== size)
    throw new GitError("ECORRUPT", "text merge output size changed while writing");
  if (conflicts === 0) return { kind: "clean", content, memory };
  return { kind: "conflict", content, conflicts, memory };
}

function memoryEstimate(
  inputBytes: number,
  lines: number,
  activeDiffLines: number,
  changes: number,
  merges: number,
  outputBytes: number,
  options: ResolvedOptions,
): TextMergeMemoryEstimate {
  const lineTableBytes = safeProduct(lines, LINE_RECORD_BYTES, "line table");
  const diffWorkspaceBytes = safeProduct(activeDiffLines, DIFF_LINE_BYTES, "diff workspace");
  const changeListBytes = safeProduct(changes, CHANGE_BYTES, "change list");
  const mergeListBytes = safeProduct(merges, MERGE_BYTES, "merge list");
  const fixedBytes = checkedSum(
    [
      FIXED_MERGE_BYTES,
      byteLength(options.labels.current),
      byteLength(options.labels.base),
      byteLength(options.labels.incoming),
    ],
    "fixed state",
  );
  const peakBytes = checkedSum(
    [
      inputBytes,
      lineTableBytes,
      diffWorkspaceBytes,
      changeListBytes,
      mergeListBytes,
      outputBytes,
      fixedBytes,
    ],
    "memory estimate",
  );
  if (peakBytes > options.limits.maxMemoryBytes) {
    throw tooBig("text merge memory", options.limits.maxMemoryBytes);
  }
  return {
    inputBytes,
    lines,
    lineTableBytes,
    diffWorkspaceBytes,
    changeListBytes,
    mergeListBytes,
    outputBytes,
    fixedBytes,
    peakBytes,
  };
}

function resolveOptions(options: TextMergeOptions): ResolvedOptions {
  const limits: TextMergeLimits = {
    maxInputBytes: cappedLimit(
      "maxInputBytes",
      options.limits?.maxInputBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxInputBytes,
    ),
    maxTotalInputBytes: cappedLimit(
      "maxTotalInputBytes",
      options.limits?.maxTotalInputBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxTotalInputBytes,
    ),
    maxLineBytes: cappedLimit(
      "maxLineBytes",
      options.limits?.maxLineBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxLineBytes,
    ),
    maxLines: cappedLimit("maxLines", options.limits?.maxLines, DEFAULT_TEXT_MERGE_LIMITS.maxLines),
    maxChanges: cappedLimit(
      "maxChanges",
      options.limits?.maxChanges,
      DEFAULT_TEXT_MERGE_LIMITS.maxChanges,
    ),
    maxConflicts: cappedLimit(
      "maxConflicts",
      options.limits?.maxConflicts,
      DEFAULT_TEXT_MERGE_LIMITS.maxConflicts,
    ),
    maxConflictBytes: cappedLimit(
      "maxConflictBytes",
      options.limits?.maxConflictBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxConflictBytes,
    ),
    maxLabelBytes: cappedLimit(
      "maxLabelBytes",
      options.limits?.maxLabelBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxLabelBytes,
    ),
    maxMarkerSize: cappedLimit(
      "maxMarkerSize",
      options.limits?.maxMarkerSize,
      DEFAULT_TEXT_MERGE_LIMITS.maxMarkerSize,
    ),
    maxOutputBytes: cappedLimit(
      "maxOutputBytes",
      options.limits?.maxOutputBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes,
    ),
    maxMemoryBytes: cappedLimit(
      "maxMemoryBytes",
      options.limits?.maxMemoryBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxMemoryBytes,
    ),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new GitError("EINVAL", `text merge ${name} must be a non-negative safe integer`);
    }
  }
  const style = options.style ?? "merge";
  const refinement = options.refinement ?? "zealous-alnum";
  if (style !== "merge" && style !== "diff3" && style !== "zdiff3") {
    throw new GitError("EINVAL", `unknown text merge style: ${style}`);
  }
  if (refinement !== "eager" && refinement !== "zealous" && refinement !== "zealous-alnum") {
    throw new GitError("EINVAL", `unknown text merge refinement: ${refinement}`);
  }
  const markerSize = options.markerSize ?? DEFAULT_MARKER_SIZE;
  if (!Number.isSafeInteger(markerSize) || markerSize <= 0) {
    throw new GitError("EINVAL", "text merge marker size must be a positive safe integer");
  }
  if (markerSize > limits.maxMarkerSize)
    throw tooBig("text merge marker size", limits.maxMarkerSize);
  return {
    style,
    refinement,
    markerSize,
    indentHeuristic: options.indentHeuristic === true,
    labels: {
      current: encodeLabel(options.labels?.current, "current", limits.maxLabelBytes),
      base: encodeLabel(options.labels?.base, "base", limits.maxLabelBytes),
      incoming: encodeLabel(options.labels?.incoming, "incoming", limits.maxLabelBytes),
    },
    limits,
  };
}

function cappedLimit(name: string, value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GitError("EINVAL", `text merge ${name} must be a non-negative safe integer`);
  }
  if (value > ceiling) {
    throw new GitError("EINVAL", `text merge ${name} exceeds its hard ceiling of ${ceiling}`);
  }
  return value;
}

function encodeLabel(label: string | undefined, role: string, limit: number): Uint8Array | null {
  if (label === undefined) return null;
  let bytes = 0;
  for (let index = 0; index < label.length; index++) {
    const unit = label.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d) {
      throw new GitError("EINVAL", `text merge ${role} label contains a structural control byte`);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = label.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new GitError("EINVAL", `text merge ${role} label contains an unpaired surrogate`);
      }
      bytes += 4;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", `text merge ${role} label contains an unpaired surrogate`);
    } else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else bytes += 3;
    if (bytes > limit) throw tooBig(`text merge ${role} label`, limit);
  }
  return new TextEncoder().encode(label);
}

function validateAndScanInputs(
  base: Uint8Array,
  current: Uint8Array,
  incoming: Uint8Array,
  limits: TextMergeLimits,
): InputInfo[] {
  const inputs = [base, current, incoming];
  for (const input of inputs) {
    if (input.length > limits.maxInputBytes) throw tooBig("text merge input", limits.maxInputBytes);
  }
  const total = checkedSum(
    inputs.map((input) => input.length),
    "input",
  );
  if (total > limits.maxTotalInputBytes) {
    throw tooBig("text merge total input", limits.maxTotalInputBytes);
  }
  const infos = inputs.map(scanInput);
  const lines = checkedSum(
    infos.map((info) => info.lines),
    "line count",
  );
  if (lines > limits.maxLines) throw tooBig("text merge line count", limits.maxLines);
  for (const info of infos) {
    if (info.maxLineBytes > limits.maxLineBytes) {
      throw tooBig("text merge line", limits.maxLineBytes);
    }
  }
  return infos;
}

function scanInput(input: Uint8Array): InputInfo {
  let lines = 0;
  let start = 0;
  let maxLineBytes = 0;
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== 0x0a) continue;
    lines++;
    maxLineBytes = Math.max(maxLineBytes, index + 1 - start);
    start = index + 1;
  }
  if (start < input.length) {
    lines++;
    maxLineBytes = Math.max(maxLineBytes, input.length - start);
  }
  return { lines, maxLineBytes };
}

function splitByteRecords(bytes: Uint8Array): ByteRecord[] {
  if (bytes.length === 0) return [];
  const records: ByteRecord[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0x0a) continue;
    records.push({ bytes, start, end: index + 1 });
    start = index + 1;
  }
  if (start < bytes.length) records.push({ bytes, start, end: bytes.length });
  return records;
}

function buildMergeRegions(
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

function refineConflicts(
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

function simplifyConflicts(
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

function refineZdiff3(regions: MergeRegion[], current: ByteRecord[], incoming: ByteRecord[]): void {
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

function validateConflictRegions(
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

function fillMerge(
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function identityMergeContent(
  base: Uint8Array,
  current: Uint8Array,
  incoming: Uint8Array,
): Uint8Array | null {
  if (bytesEqual(current, incoming)) return current;
  if (bytesEqual(base, current)) return incoming;
  if (bytesEqual(base, incoming)) return current;
  return null;
}

function byteLength(bytes: Uint8Array | null): number {
  return bytes?.length ?? 0;
}

function addSize(size: number, addition: number, limit: number): number {
  const next = checkedSum([size, addition], "output");
  if (next > limit) throw tooBig("text merge output", limit);
  return next;
}

function checkedSum(values: number[], resource: string): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum))
      throw new GitError("E2BIG", `text merge ${resource} exceeds safe capacity`);
  }
  return sum;
}

function safeProduct(left: number, right: number, resource: string): number {
  const product = left * right;
  if (!Number.isSafeInteger(product))
    throw new GitError("E2BIG", `text merge ${resource} exceeds safe capacity`);
  return product;
}

function tooBig(resource: string, limit: number): GitError {
  return new GitError("E2BIG", `${resource} exceeds ${limit}`);
}
