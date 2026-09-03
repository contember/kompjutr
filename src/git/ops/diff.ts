// `diff` and `diffSummary`.
//
// Four modes: working tree vs HEAD, working tree vs a ref, a commit pair,
// and a selected tree vs the index. Patch rendering and collection live in
// phase-specific sidecars; this module preserves the public entry point.

import {
  classifyDiffRenames,
  collect,
  collectPendingChanges,
  treePendingChanges,
} from "./diff-collect.js";
import { renderPatch } from "./diff-format.js";
import type { DiffOptions, PendingChange } from "./diff-internal.js";
import type { DiffFormatOptions, TreeDiffOptions } from "./diff-types.js";
import type { Repository } from "./repository.js";
import type { SparseWorkspaceSource } from "./sparse-workspace.js";
import type { Worktree } from "./worktree.js";

export { DIFF_COMBINED_MAX_LINES, DIFF_COMBINED_MAX_MEMORY_BYTES } from "./diff-combined.js";
export type { DiffOptions } from "./diff-internal.js";
export { diffHeaderPath } from "./diff-path-format.js";
export {
  diffSummary,
  diffSummaryBounded,
  diffSummaryEntryRetainedBytes,
} from "./diff-summary.js";
export type { DiffFormatOptions, TreeDiffOptions } from "./diff-types.js";
export { DIFF_MAX_OUTPUT_BYTES } from "./diff-types.js";

export function diff(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions = {},
  sparseWorkspace?: SparseWorkspaceSource,
  formatOptions: DiffFormatOptions = {},
): string {
  return renderPatch(
    collect(repo, worktree, options, sparseWorkspace, formatOptions.indexBase === true),
    options,
    formatOptions,
  );
}

/** Render a patch between two selected trees without consulting the worktree. */
export function diffTrees(
  repo: Repository,
  beforeTree: string | null,
  afterTree: string | null,
  options: TreeDiffOptions = {},
  formatOptions: DiffFormatOptions = {},
): string {
  const changes = (): Generator<PendingChange> =>
    treePendingChanges(repo, beforeTree, afterTree, options);
  return renderPatch(
    collectPendingChanges(
      repo,
      undefined,
      changes(),
      classifyDiffRenames(repo, options, changes()),
    ),
    options,
    formatOptions,
  );
}
