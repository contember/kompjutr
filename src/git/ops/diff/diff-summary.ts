import { utf8Decoder } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { diffText } from "../../diff/index.js";
import { isBinary } from "../../diff/lines.js";
import type { DiffSummaryEntry } from "../core/kinds.js";
import type { Repository } from "../repository/repository.js";
import type { SparseWorkspaceSource } from "../worktree/sparse-workspace.js";
import type { Worktree } from "../worktree/worktree.js";
import { collect } from "./diff-collect.js";
import type { DiffOptions } from "./diff-internal.js";
import {
  diffStringBytes,
  endpointBytes,
  isCombinedFileChange,
  isUnmergedFileChange,
} from "./diff-types.js";

const DIFF_SUMMARY_ENTRY_FIXED_BYTES = 128;
const DIFF_SUMMARY_MAX_ROWS = 50_000;
const DIFF_REPOSITORY_BYTES = 8 * 1024 * 1024;

export function diffSummary(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions = {},
  sparseWorkspace?: SparseWorkspaceSource,
): DiffSummaryEntry[] {
  return [...diffSummaryEntries(repo, worktree, options, sparseWorkspace)];
}

/** Internal bounded summary materialization for output-producing adapters. */
export function diffSummaryBounded(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  sparseWorkspace: SparseWorkspaceSource | undefined,
  limits: { maxRows: number; maxRetainedBytes: number },
): DiffSummaryEntry[] {
  validateDiffSummaryLimits(limits);
  const out: DiffSummaryEntry[] = [];
  let retainedBytes = 0;
  for (const entry of diffSummaryEntries(repo, worktree, options, sparseWorkspace)) {
    if (out.length >= limits.maxRows) {
      throw new GitError("E2BIG", `diff summary exceeds ${limits.maxRows} rows`);
    }
    const bytes = diffSummaryEntryRetainedBytes(entry);
    if (bytes > limits.maxRetainedBytes - retainedBytes) {
      throw new GitError("E2BIG", `diff summary exceeds ${limits.maxRetainedBytes} retained bytes`);
    }
    retainedBytes += bytes;
    out.push(entry);
  }
  return out;
}

function* diffSummaryEntries(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions,
  sparseWorkspace: SparseWorkspaceSource | undefined,
): Generator<DiffSummaryEntry> {
  for (const change of collect(repo, worktree, options, sparseWorkspace)) {
    if (isCombinedFileChange(change) || isUnmergedFileChange(change)) {
      throw new CorruptError("tree-based diff summary produced an index conflict");
    }
    if (change.originalPath !== undefined && change.similarity !== undefined) {
      yield {
        path: change.path,
        originalPath: change.originalPath,
        similarity: change.similarity,
        status: "R",
        insertions: 0,
        deletions: 0,
      };
      continue;
    }
    const status = change.before === null ? "A" : change.after === null ? "D" : "M";
    if (change.before?.oid === change.after?.oid) {
      yield { path: change.path, status, insertions: 0, deletions: 0 };
      continue;
    }
    const oldBytes = change.before === null ? new Uint8Array(0) : endpointBytes(change.before);
    const newBytes = change.after === null ? new Uint8Array(0) : endpointBytes(change.after);
    if (isBinary(oldBytes) || isBinary(newBytes)) {
      // git prints "-" for a binary file; there is no line count to give.
      yield { path: change.path, status, insertions: 0, deletions: 0 };
      continue;
    }
    const text = diffText(utf8Decoder.decode(oldBytes), utf8Decoder.decode(newBytes));
    yield {
      path: change.path,
      status,
      insertions: text.insertions,
      deletions: text.deletions,
    };
  }
}

function validateDiffSummaryLimits(limits: { maxRows: number; maxRetainedBytes: number }): void {
  if (
    !Number.isSafeInteger(limits.maxRows) ||
    limits.maxRows < 0 ||
    limits.maxRows > DIFF_SUMMARY_MAX_ROWS
  ) {
    throw new GitError(
      "EINVAL",
      `diff summary row limit must be between 0 and ${DIFF_SUMMARY_MAX_ROWS}`,
    );
  }
  if (
    !Number.isSafeInteger(limits.maxRetainedBytes) ||
    limits.maxRetainedBytes < 0 ||
    limits.maxRetainedBytes > DIFF_REPOSITORY_BYTES
  ) {
    throw new GitError(
      "EINVAL",
      `diff summary retained limit must be between 0 and ${DIFF_REPOSITORY_BYTES} bytes`,
    );
  }
}

export function diffSummaryEntryRetainedBytes(entry: DiffSummaryEntry): number {
  return (
    DIFF_SUMMARY_ENTRY_FIXED_BYTES +
    diffStringBytes(entry.path) +
    (entry.originalPath === undefined ? 0 : diffStringBytes(entry.originalPath))
  );
}
