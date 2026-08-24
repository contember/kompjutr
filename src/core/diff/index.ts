// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from the xdiff library as it appears in git, which derives from
// LibXDiff, Copyright (C) 2003 Davide Libenzi <davidel@xmailserver.org>.
// LGPL-2.1-or-later, like the original. See ./LICENSE — this directory is
// the one part of kompjutr that is not MIT.

// The text-diff engine: a port of git's line differ plus its unified
// output. No dependency on the repository, the worktree or SQL — bytes in,
// patch text out.

import { isBinary, splitLines } from "./lines.js";
import { type ChangeGroup, diffLines } from "./myers.js";
import { type UnifiedOptions, unifiedHunks } from "./unified.js";

export { isBinary, splitLines } from "./lines.js";
export { type ChangeGroup, diffLines } from "./myers.js";
export { type UnifiedOptions, unifiedHunks } from "./unified.js";
export {
  DEFAULT_TEXT_MERGE_LIMITS,
  estimateTextMergeMemory,
  mergeText,
  type TextMergeLabels,
  type TextMergeLimits,
  type TextMergeMemoryEstimate,
  type TextMergeOptions,
  type TextMergeRefinement,
  type TextMergeResult,
  type TextMergeStyle,
} from "./xmerge.js";

export interface TextDiff {
  changes: ChangeGroup[];
  insertions: number;
  deletions: number;
  /** The hunks, or "" when the two texts are identical. */
  hunks: string;
}

export function diffText(oldText: string, newText: string, options: UnifiedOptions = {}): TextDiff {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const changes = diffLines(oldLines, newLines);
  let insertions = 0;
  let deletions = 0;
  for (const change of changes) {
    insertions += change.newCount;
    deletions += change.oldCount;
  }
  return {
    changes,
    insertions,
    deletions,
    hunks: changes.length === 0 ? "" : unifiedHunks(oldLines, newLines, changes, options),
  };
}

/** True when git would refuse to diff these bytes as text. */
export function eitherIsBinary(before: Uint8Array | null, after: Uint8Array | null): boolean {
  return (before !== null && isBinary(before)) || (after !== null && isBinary(after));
}
