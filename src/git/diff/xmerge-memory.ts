// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from Git's xdiff/xmerge.c at 94f057755b7941b321fd11fec1b2e3ca5313a4e0
// (v2.54.0). LibXDiff is Copyright (C) 2003-2006 Davide Libenzi and
// Johannes E. Schindelin. LGPL-2.1-or-later, like the original.

import { isBinary } from "./lines.js";
import {
  byteLength,
  checkedSum,
  identityMergeContent,
  safeProduct,
  tooBig,
} from "./xmerge-helpers.js";
import { resolveOptions, validateAndScanInputs } from "./xmerge-input.js";
import {
  CHANGE_BYTES,
  DIFF_LINE_BYTES,
  FIXED_MERGE_BYTES,
  LINE_RECORD_BYTES,
  MERGE_BYTES,
  type ResolvedOptions,
  type TextMergeMemoryEstimate,
  type TextMergeOptions,
} from "./xmerge-types.js";

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

export function estimateResolvedTextMergeMemory(
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
