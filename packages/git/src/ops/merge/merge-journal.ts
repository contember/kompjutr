import { GitError } from "../../common/errors.js";
import { joinSorted } from "../../common/streams.js";
import { readOperationStateOwned } from "../../store/index.js";
import {
  mergeJournalFromOperation,
  operationKindMismatch,
  operationNotActive,
} from "../core/operation-state.js";
import { planIntegration } from "../integration/integration.js";
import {
  projectedTouchedShape,
  projectIntegrationWithCollisions,
  touchedPathSet,
} from "../integration/integration-worktree.js";
import type { Repository } from "../repository/repository.js";
import { treeStream } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import { selectMergeBases } from "./merge-base.js";
import type { MergeJournal, MergeTouchedPath } from "./merge-state.js";
import { commitTree, selectedBaseTree, type VirtualState } from "./merge-virtual-base.js";

function snapshotMode(entry: MergeTouchedPath): string | null {
  const snapshot = entry.worktree;
  if (snapshot.kind === "symlink") return "120000";
  if (snapshot.kind === "file") return (snapshot.mode & 0o111) === 0 ? "100644" : "100755";
  return null;
}

function requireOriginalSnapshots(repo: Repository, journal: MergeJournal): void {
  const currentTree = commitTree(repo, journal.state.currentParentOid);
  for (const row of joinSorted(treeStream(repo, currentTree), journal.touched, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const saved = row.right;
    if (saved === undefined) continue;
    const expected = row.left;
    const index = saved.index;
    if (expected === undefined) {
      if (index !== null) {
        throw new GitError("ECORRUPT", `merge journal index snapshot differs at ${saved.path}`);
      }
      if (saved.worktree.kind !== "absent" && saved.worktree.kind !== "directory") {
        throw new GitError("ECORRUPT", `merge journal worktree snapshot differs at ${saved.path}`);
      }
      continue;
    }
    if (
      index === null ||
      index.oid !== expected.oid ||
      index.mode !== Number.parseInt(expected.mode, 8)
    ) {
      throw new GitError("ECORRUPT", `merge journal index snapshot differs at ${saved.path}`);
    }
    if (saved.worktree.kind === "absent") continue;
    if (saved.worktree.kind !== "file" && saved.worktree.kind !== "symlink") {
      throw new GitError("ECORRUPT", `merge journal worktree snapshot differs at ${saved.path}`);
    }
    if (saved.worktree.oid !== expected.oid || snapshotMode(saved) !== expected.mode) {
      throw new GitError("ECORRUPT", `merge journal worktree snapshot differs at ${saved.path}`);
    }
  }
}

export function requireJournalOwnership(
  repo: Repository,
  worktree: Worktree,
  journal: MergeJournal,
): void {
  const state = journal.state;
  requireOriginalSnapshots(repo, journal);
  const selection = selectMergeBases(repo, {
    currentOid: state.currentParentOid,
    incomingOid: state.incomingParentOid,
  });
  if (selection.kind === "shallow") {
    throw new GitError("ESHALLOW", "cannot verify merge journal across a shallow boundary");
  }
  if (selection.kind === "unrelated" || selection.kind === "already-merged") {
    throw new GitError("ECORRUPT", "merge journal parents do not describe an incomplete merge");
  }
  const currentTree = commitTree(repo, state.currentParentOid);
  const incomingTree = commitTree(repo, state.incomingParentOid);
  const virtualState: VirtualState = { commits: 0 };
  const baseTree = selectedBaseTree(repo, selection.bases, virtualState);
  const plan = planIntegration(repo, {
    baseTreeOid: baseTree,
    currentTreeOid: currentTree,
    incomingTreeOid: incomingTree,
    text: {
      labels: {
        current: state.currentLabel,
        base: "base",
        incoming: state.incomingLabel,
      },
    },
  });
  const omitted = touchedPathSet(journal.touched);
  const projected = projectIntegrationWithCollisions(
    repo,
    worktree,
    baseTree,
    incomingTree,
    plan,
    state.currentLabel,
    state.incomingLabel,
    omitted,
    "merge",
  );
  const expected = projectedTouchedShape(projected);
  if (expected.length !== journal.touched.length) {
    throw new GitError("ECORRUPT", "merge journal path ownership is incomplete");
  }
  for (let index = 0; index < expected.length; index++) {
    const wanted = expected[index];
    const saved = journal.touched[index];
    if (
      wanted === undefined ||
      saved === undefined ||
      wanted.path !== saved.path ||
      wanted.logicalPath !== saved.logicalPath ||
      wanted.purpose !== saved.purpose
    ) {
      throw new GitError("ECORRUPT", "merge journal path ownership differs from its parents");
    }
  }
}

export function requireMergeJournalOwned(repo: Repository): MergeJournal {
  const journal = readOperationStateOwned(repo.checkout);
  if (journal === null) throw operationNotActive("merge");
  if (journal.kind !== "merge") throw operationKindMismatch("merge", journal.kind);
  return mergeJournalFromOperation(journal);
}
