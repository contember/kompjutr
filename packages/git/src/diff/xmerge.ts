// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from Git's xdiff/xmerge.c at 94f057755b7941b321fd11fec1b2e3ca5313a4e0
// (v2.54.0). LibXDiff is Copyright (C) 2003-2006 Davide Libenzi and
// Johannes E. Schindelin. LGPL-2.1-or-later, like the original.

import { GitError } from "../common/errors.js";
import { isBinary } from "./lines.js";
import { diffByteRecords } from "./myers.js";
import { bytesEqual, tooBig } from "./xmerge-helpers.js";
import { resolveOptions, splitByteRecords } from "./xmerge-input.js";
import { estimateResolvedTextMergeMemory } from "./xmerge-memory.js";
import { fillMerge, validateConflictRegions } from "./xmerge-output.js";
import {
  buildMergeRegions,
  refineConflicts,
  refineZdiff3,
  simplifyConflicts,
} from "./xmerge-regions.js";
import type { TextMergeOptions, TextMergeResult } from "./xmerge-types.js";

export { estimateTextMergeMemory } from "./xmerge-memory.js";
export type {
  TextMergeLabels,
  TextMergeLimits,
  TextMergeMemoryEstimate,
  TextMergeOptions,
  TextMergeRefinement,
  TextMergeResult,
  TextMergeStyle,
} from "./xmerge-types.js";
export { DEFAULT_TEXT_MERGE_LIMITS } from "./xmerge-types.js";

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
