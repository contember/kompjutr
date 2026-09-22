import { GitError } from "../../common/errors.js";
import { joinSorted } from "../../common/streams.js";
import {
  type IntegrationWorkspace,
  withIntegrationWorkspaceOwned,
} from "../../store/operations/integration-workspace/workspace.js";
import {
  iterateOperationTouchedOwned,
  readOperationHeaderOwned,
} from "../../store/operations/operation-journal.js";
import type { OperationTouchedSource } from "../../store/operations/operation-journal-types.js";
import { operationKindMismatch, operationNotActive } from "../core/operation-state.js";
import { projectIntegrationWithCollisionsOwned } from "../integration/integration-collisions-owned.js";
import { planIntegrationOwned } from "../integration/integration-plan-owned.js";
import { integrationTouched } from "../integration/integration-touched.js";
import type { Repository } from "../repository/repository.js";
import { treeStream } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import { selectMergeBases } from "./merge-base.js";
import type { MergeJournal, MergeTouchedPath } from "./merge-state.js";
import { commitTree, selectedBaseTreeOwned, type VirtualState } from "./merge-virtual-base.js";

function snapshotMode(entry: MergeTouchedPath): string | null {
  const snapshot = entry.worktree;
  if (snapshot.kind === "symlink") return "120000";
  if (snapshot.kind === "file") return (snapshot.mode & 0o111) === 0 ? "100644" : "100755";
  return null;
}

function requireOriginalSnapshots(
  repo: Repository,
  journal: MergeJournal<OperationTouchedSource>,
): void {
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
  journal: MergeJournal<OperationTouchedSource>,
): void {
  withIntegrationWorkspaceOwned(repo.store, (workspace) =>
    validateOwnership(workspace, repo, worktree, journal),
  );
}

function validateOwnership(
  workspace: IntegrationWorkspace,
  repo: Repository,
  worktree: Worktree,
  journal: MergeJournal<OperationTouchedSource>,
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
  const baseTree = selectedBaseTreeOwned(workspace, repo, selection.bases, virtualState);
  const plan = planIntegrationOwned(workspace, {
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
  const omitted = workspace.touched(plan);
  omitted.reserve(journal.touched);
  const projected = projectIntegrationWithCollisionsOwned(
    workspace,
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
  const expected = integrationTouched(workspace, projected);
  if (expected.length !== journal.touched.length) {
    throw new GitError("ECORRUPT", "merge journal path ownership is incomplete");
  }
  for (const row of joinSorted(expected.shapes(), journal.touched, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const wanted = row.left;
    const saved = row.right;
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

export function requireMergeJournalOwned(repo: Repository): MergeJournal<OperationTouchedSource> {
  const journal = readOperationHeaderOwned(repo.checkout);
  if (journal === null) throw operationNotActive("merge");
  if (journal.state.kind !== "merge") throw operationKindMismatch("merge", journal.state.kind);
  const { kind: _kind, ...state } = journal.state;
  return {
    state,
    touched: {
      length: journal.touchedCount,
      [Symbol.iterator]: () => iterateOperationTouchedOwned(repo.checkout)[Symbol.iterator](),
    },
  };
}
