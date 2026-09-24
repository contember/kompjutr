import { utf8Decoder } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import { diffText } from "../../diff/index.js";
import { isBinary } from "../../diff/lines.js";
import type { SparseWorkspaceSource } from "../../store/core/contracts.js";
import type { DiffSummaryEntry } from "../core/kinds.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { collect } from "./diff-collect.js";
import type { DiffOptions } from "./diff-internal.js";
import {
  endpointBytes,
  isCombinedFileChange,
  isUnmergedFileChange,
  type PatchChange,
} from "./diff-types.js";

export function diffSummary(
  repo: Repository,
  worktree: Worktree,
  options: DiffOptions = {},
  sparseWorkspace?: SparseWorkspaceSource,
): DiffSummaryEntry[] {
  return [...summarizeChanges(collect(repo, worktree, options, sparseWorkspace))];
}

export function* summarizeChanges(changes: Iterable<PatchChange>): Generator<DiffSummaryEntry> {
  for (const change of changes) {
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
