import { CorruptError } from "../../../common/errors.js";
import type { MergeTouchedPath, MergeWorktreeSnapshot } from "../../merge/merge-state.js";
import type { Repository } from "../../repository/repository.js";
import type { Worktree, WorktreeStat } from "../../worktree/worktree.js";
import { type HashedPath, hashExactWorktreePaths } from "../../worktree/worktree-io.js";
import type { SnapshotDraft } from "./apply-types.js";

function validateCanonicalUtf16(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new CorruptError(`${label} is not canonical UTF-16`);
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError(`${label} is not canonical UTF-16`);
    }
  }
}

export function snapshotWorktreeObjects(
  repo: Repository,
  worktree: Worktree,
  drafts: readonly SnapshotDraft[],
): Map<string, HashedPath> {
  const paths: { path: string; stat: WorktreeStat }[] = [];
  for (const draft of drafts) {
    const stat = draft.stat;
    if (stat?.type === "symlink") {
      if (stat.target === null) {
        throw new CorruptError(`worktree symlink ${draft.spec.path} has no target`);
      }
      validateCanonicalUtf16(stat.target, `merge snapshot symlink ${draft.spec.path}`);
    }
    if (stat?.type === "file" || stat?.type === "symlink") {
      paths.push({ path: draft.spec.path, stat });
    }
  }
  const hashed = hashExactWorktreePaths(repo, worktree, paths, {
    write: true,
  });
  for (const draft of drafts) {
    if (
      (draft.stat?.type === "file" || draft.stat?.type === "symlink") &&
      !hashed.has(draft.spec.path)
    ) {
      throw new CorruptError(`merge snapshot lost worktree path ${draft.spec.path}`);
    }
  }
  return hashed;
}

function worktreeSnapshot(draft: SnapshotDraft, oid: string | undefined): MergeWorktreeSnapshot {
  const stat = draft.stat;
  if (stat === null) return { kind: "absent" };
  if (stat.type === "dir") return { kind: "directory", mode: stat.mode, revision: stat.rev };
  if (oid === undefined) throw new CorruptError(`merge snapshot lacks object ${draft.spec.path}`);
  return { kind: stat.type, mode: stat.mode, oid, revision: stat.rev };
}

export function touchedFromDrafts(
  drafts: readonly SnapshotDraft[],
  snapshots: ReadonlyMap<string, HashedPath> | null,
): MergeTouchedPath[] {
  return drafts.map((draft) => ({
    path: draft.spec.path,
    logicalPath: draft.spec.logicalPath,
    purpose: draft.spec.purpose,
    index: draft.index,
    worktree: worktreeSnapshot(
      draft,
      snapshots === null ? "0".repeat(40) : snapshots.get(draft.spec.path)?.oid,
    ),
  }));
}
