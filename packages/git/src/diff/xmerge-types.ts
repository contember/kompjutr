// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from Git's xdiff/xmerge.c at 94f057755b7941b321fd11fec1b2e3ca5313a4e0
// (v2.54.0). LibXDiff is Copyright (C) 2003-2006 Davide Libenzi and
// Johannes E. Schindelin. LGPL-2.1-or-later, like the original.

export const MIB = 1024 * 1024;
export const DEFAULT_MARKER_SIZE = 7;
export const LINE_RECORD_BYTES = 96;
export const DIFF_LINE_BYTES = 320;
// Base-to-side scripts remain retained while refinement creates another script.
export const CHANGE_BYTES = 192;
// Refinement and simplification build a new 128-byte region list while the old one is retained.
export const MERGE_BYTES = 256;
export const FIXED_MERGE_BYTES = 4096;

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

export interface InputInfo {
  lines: number;
  maxLineBytes: number;
}

export interface EncodedLabels {
  current: Uint8Array | null;
  base: Uint8Array | null;
  incoming: Uint8Array | null;
}

export interface ResolvedOptions {
  style: TextMergeStyle;
  refinement: TextMergeRefinement;
  labels: EncodedLabels;
  markerSize: number;
  indentHeuristic: boolean;
  limits: TextMergeLimits;
}

export interface MergeRegion {
  mode: number;
  baseStart: number;
  baseCount: number;
  currentStart: number;
  currentCount: number;
  incomingStart: number;
  incomingCount: number;
}
