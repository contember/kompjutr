import { checkoutStoreMutations } from "../store/checkout.js";
import { markReplayEmptyOwned, writeOperationJournalOwned } from "../store/operation-journal.js";
// Shared orchestration for one bounded cherry-pick or revert operation.

import { GitError } from "../common/errors.js";
import { hashObject, type Person } from "../common/objects.js";
import { joinSorted } from "../common/streams.js";
import { readOperationStateOwned } from "../store/index.js";
import { type CommitIdentities, commitIndex } from "./commit.js";
import type { GitContext, GitIdentity } from "./context.js";
import {
  integrationIndexMatchesTree,
  projectedTouchedShape,
  projectIntegrationWithCollisions,
  prospectiveIntegrationIndexEntries,
  requireBoundedIntegrationIndex,
  requireBoundedIntegrationTree,
  requireCleanIntegrationIndex,
  requireSafeIntegrationWorktree,
  touchedPathSet,
} from "./integration-worktree.js";
import type { ReplayEmptyReason, ReplayResult } from "./kinds.js";
import { applyProjectedOperation, restoreProjectedOperation } from "./merge-apply.js";
import {
  type CherryPickJournal,
  type OperationJournal,
  operationKindMismatch,
  operationNotActive,
  operationStepsForState,
  type ReplayKind,
  type ReplayStateMetadata,
  type RevertJournal,
} from "./operation-state.js";
import { planReplay, type ReplayIncomingLabelStyle, type ReplayPlan } from "./replay.js";
import type { Repository, ResolvedHead } from "./repository.js";
import { treeStream } from "./tree-stream.js";
import type { Worktree } from "./worktree.js";

const EMPTY_TREE_OID = hashObject("tree", new Uint8Array());

export interface ReplayStartOptions {
  source: string;
  mainline?: number;
  message?: string;
  author?: GitIdentity;
  committer?: GitIdentity;
  env?: Record<string, string>;
}

export interface ReplayContinueOptions {
  message?: string;
  author?: GitIdentity;
  committer?: GitIdentity;
  env?: Record<string, string>;
}

export interface ReplayPolicy {
  kind: ReplayKind;
  incomingLabelStyle: ReplayIncomingLabelStyle;
  suspendEmpty: boolean;
  defaultMessage(plan: ReplayPlan): string;
  resolveIdentities(
    context: GitContext,
    repo: Repository,
    plan: ReplayPlan,
    input: ReplayContinueOptions,
  ): CommitIdentities;
}

function requireReplayHead(
  repo: Repository,
  kind: ReplayKind,
): ResolvedHead & {
  ref: string;
  oid: string;
} {
  const head = repo.head();
  if (head.ref === null) throw new GitError("EDETACHED", `cannot ${kind} with a detached HEAD`);
  if (!head.ref.startsWith("refs/heads/")) {
    throw new GitError("EWRONGHEAD", `cannot ${kind}: HEAD is not a checked-out branch`);
  }
  if (head.oid === null) throw new GitError("ENOCOMMIT", `cannot ${kind} on an unborn branch`);
  return { ref: head.ref, oid: head.oid };
}

function requireOriginalHead(
  repo: Repository,
  state: ReplayStateMetadata,
): ResolvedHead & {
  ref: string;
  oid: string;
} {
  const head = repo.head();
  if (head.ref !== state.originalHeadRef || head.oid !== state.originalHeadOid) {
    throw new GitError("ESTALEHEAD", `HEAD changed during the ${state.kind} operation`);
  }
  return { ref: state.originalHeadRef, oid: state.originalHeadOid };
}

function requireReplayJournal(
  repo: Repository,
  kind: ReplayKind,
): CherryPickJournal | RevertJournal {
  const journal = readOperationStateOwned(repo.checkout);
  if (journal === null) throw operationNotActive(kind);
  if (kind === "cherry-pick") {
    if (journal.kind !== "cherry-pick") throw operationKindMismatch(kind, journal.kind);
    return journal;
  }
  if (journal.kind !== "revert") throw operationKindMismatch(kind, journal.kind);
  return journal;
}

function savedIdentity(identity: GitIdentity | undefined): GitIdentity | null {
  return identity ?? null;
}

function sourceAuthor(author: Person): GitIdentity {
  return { name: author.name, email: author.email };
}

function replayState(
  policy: ReplayPolicy,
  plan: ReplayPlan,
  head: { ref: string; oid: string },
  phase: "conflicted" | "empty",
  emptyReason: ReplayEmptyReason | null,
  message: string,
  input: ReplayStartOptions,
): ReplayStateMetadata {
  return {
    kind: policy.kind,
    originalHeadRef: head.ref,
    originalHeadOid: head.oid,
    phase,
    emptyReason,
    sourceOid: plan.sourceOid,
    selectedParentOid: plan.selectedParentOid,
    mainline: plan.mainline,
    currentLabel: plan.labels.current,
    incomingLabel: plan.labels.incoming,
    message,
    author:
      policy.kind === "cherry-pick"
        ? sourceAuthor(plan.sourceCommit.author)
        : savedIdentity(input.author),
    committer: savedIdentity(input.committer),
  };
}

function emptyReason(plan: ReplayPlan): ReplayEmptyReason {
  const parentTree = plan.selectedParentTreeOid ?? EMPTY_TREE_OID;
  return plan.sourceTreeOid === parentTree ? "source" : "result";
}

function conflicts(entries: ReplayPlan["integration"]["entries"]): boolean {
  return entries.some((entry) => entry.kind === "conflict");
}

function planForState(
  repo: Repository,
  state: ReplayStateMetadata,
  incomingLabelStyle: ReplayIncomingLabelStyle,
): ReplayPlan {
  const plan = planReplay(repo, {
    kind: state.kind,
    source: state.sourceOid,
    currentOid: state.originalHeadOid,
    mainline: state.mainline ?? undefined,
    incomingLabelStyle,
  });
  if (
    plan.sourceOid !== state.sourceOid ||
    plan.selectedParentOid !== state.selectedParentOid ||
    plan.mainline !== state.mainline ||
    plan.labels.current !== state.currentLabel ||
    plan.labels.incoming !== state.incomingLabel
  ) {
    throw new GitError("ECORRUPT", `${state.kind} journal differs from its replay plan`);
  }
  return plan;
}

function requireOriginalSnapshots(repo: Repository, journal: OperationJournal): void {
  const originalTree = repo.readCommit(journal.state.originalHeadOid).tree;
  for (const row of joinSorted(treeStream(repo, originalTree), journal.touched, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const saved = row.right;
    if (saved === undefined) continue;
    const expected = row.left;
    if (expected === undefined) {
      if (saved.index !== null) {
        throw new GitError("ECORRUPT", `replay snapshot differs at ${saved.path}`);
      }
      continue;
    }
    if (
      saved.index === null ||
      saved.index.oid !== expected.oid ||
      saved.index.mode !== Number.parseInt(expected.mode, 8)
    ) {
      throw new GitError("ECORRUPT", `replay snapshot differs at ${saved.path}`);
    }
    const worktree = saved.worktree;
    if (worktree.kind === "absent") continue;
    if (worktree.kind !== "file" && worktree.kind !== "symlink") {
      throw new GitError("ECORRUPT", `replay worktree snapshot differs at ${saved.path}`);
    }
    const mode =
      worktree.kind === "symlink" ? "120000" : (worktree.mode & 0o111) === 0 ? "100644" : "100755";
    if (worktree.oid !== expected.oid || mode !== expected.mode) {
      throw new GitError("ECORRUPT", `replay worktree snapshot differs at ${saved.path}`);
    }
  }
}

function requireOwnership(
  repo: Repository,
  worktree: Worktree,
  journal: CherryPickJournal | RevertJournal,
  incomingLabelStyle: ReplayIncomingLabelStyle,
): ReplayPlan {
  requireOriginalSnapshots(repo, journal);
  const plan = planForState(repo, journal.state, incomingLabelStyle);
  const omitted = touchedPathSet(journal.touched);
  const projected = projectIntegrationWithCollisions(
    repo,
    worktree,
    plan.baseTreeOid,
    plan.incomingTreeOid,
    plan.integration,
    plan.labels.current,
    plan.labels.incoming,
    omitted,
    plan.kind,
  );
  const expected = projectedTouchedShape(projected);
  if (expected.length !== journal.touched.length) {
    throw new GitError("ECORRUPT", "replay journal path ownership is incomplete");
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
      throw new GitError("ECORRUPT", "replay journal path ownership differs from its plan");
    }
  }
  return plan;
}

export function startReplay(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  input: ReplayStartOptions,
  policy: ReplayPolicy,
): ReplayResult {
  return repo.store.db.transactionSync(() => {
    repo.checkout.requireNoOperationState();
    const head = requireReplayHead(repo, policy.kind);
    const currentTree = repo.readCommit(head.oid).tree;
    requireBoundedIntegrationIndex(repo);
    requireCleanIntegrationIndex(repo, currentTree, policy.kind);
    const plan = planReplay(repo, {
      kind: policy.kind,
      source: input.source,
      currentOid: head.oid,
      mainline: input.mainline,
      incomingLabelStyle: policy.incomingLabelStyle,
    });
    const message = input.message ?? policy.defaultMessage(plan);
    if (plan.integration.entries.length === 0) {
      const reason = emptyReason(plan);
      if (policy.suspendEmpty) {
        const state = replayState(policy, plan, head, "empty", reason, message, input);
        const steps = operationStepsForState(state);
        writeOperationJournalOwned(repo.checkout, state, steps, []);
      }
      return { outcome: "empty", reason };
    }
    const projected = projectIntegrationWithCollisions(
      repo,
      worktree,
      plan.baseTreeOid,
      plan.incomingTreeOid,
      plan.integration,
      plan.labels.current,
      plan.labels.incoming,
      undefined,
      policy.kind,
    );
    requireSafeIntegrationWorktree(
      repo,
      worktree,
      plan.incomingTreeOid,
      plan.integration.entries,
      policy.kind,
    );
    requireBoundedIntegrationTree(repo, () => prospectiveIntegrationIndexEntries(repo, projected));
    const conflicted = conflicts(plan.integration.entries);
    const current = repo.head();
    if (current.ref !== head.ref || current.oid !== head.oid) {
      throw new GitError("ESTALEHEAD", `HEAD changed while ${policy.kind} was being prepared`);
    }
    const state = conflicted
      ? replayState(policy, plan, head, "conflicted", null, message, input)
      : null;
    applyProjectedOperation(repo, worktree, projected, { suspendedState: state });
    if (conflicted) return { outcome: "conflicted" };
    const identities = policy.resolveIdentities(context, repo, plan, input);
    const result = commitIndex(
      repo,
      {
        message,
        parent: [head.oid],
        identities,
        expectedHead: head,
        refLogReason: policy.kind,
      },
      context,
    );
    return { outcome: "committed", oid: result.oid };
  });
}

export function continueReplay(
  context: GitContext,
  repo: Repository,
  input: ReplayContinueOptions,
  policy: ReplayPolicy,
): ReplayResult {
  return repo.store.db.transactionSync(() => {
    const journal = requireReplayJournal(repo, policy.kind);
    const head = requireOriginalHead(repo, journal.state);
    const plan = requireOwnership(repo, context.worktree, journal, policy.incomingLabelStyle);
    if (journal.state.phase === "empty") {
      const reason = journal.state.emptyReason;
      if (reason === null) throw new GitError("ECORRUPT", "empty replay lost its reason");
      return { outcome: "empty", reason };
    }
    if (repo.checkout.hasConflicts()) {
      throw new GitError(
        "EUNMERGED",
        `cannot continue ${policy.kind}: the index has unmerged paths`,
      );
    }
    requireBoundedIntegrationIndex(repo);
    if (integrationIndexMatchesTree(repo, plan.currentTreeOid)) {
      const reason: ReplayEmptyReason = "result";
      if (policy.suspendEmpty) {
        markReplayEmptyOwned(repo.checkout, policy.kind, reason);
      } else {
        checkoutStoreMutations(repo.checkout).clearOperationStateOwned();
      }
      return { outcome: "empty", reason };
    }
    const identities = policy.resolveIdentities(context, repo, plan, {
      message: input.message,
      author: input.author ?? journal.state.author ?? undefined,
      committer: input.committer ?? journal.state.committer ?? undefined,
      env: input.env,
    });
    const result = commitIndex(
      repo,
      {
        message: input.message ?? journal.state.message,
        parent: [journal.state.originalHeadOid],
        identities,
        expectedHead: head,
        refLogReason: policy.kind,
      },
      context,
    );
    checkoutStoreMutations(repo.checkout).clearOperationStateOwned();
    return { outcome: "committed", oid: result.oid };
  });
}

export function cancelReplay(repo: Repository, worktree: Worktree, kind: ReplayKind): void {
  repo.store.db.transactionSync(() => {
    const journal = requireReplayJournal(repo, kind);
    requireOriginalHead(repo, journal.state);
    if (journal.state.phase !== "empty") {
      const incomingLabelStyle: ReplayIncomingLabelStyle =
        kind === "cherry-pick" ? "source-subject" : "parent-of-source-subject";
      requireOwnership(repo, worktree, journal, incomingLabelStyle);
      if (journal.touched.length > 0) {
        restoreProjectedOperation(repo, worktree, journal);
      }
    }
    checkoutStoreMutations(repo.checkout).clearOperationStateOwned();
  });
}
