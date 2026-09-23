import { checkoutStoreMutations } from "../../store/core/checkout-mutations-registry.js";
import {
  markReplayEmptyOwned,
  writeOperationJournalOwned,
} from "../../store/operations/operation-journal.js";
// Shared orchestration for one bounded cherry-pick or revert operation.

import { GitError } from "../../common/errors.js";
import { type Commit, hashObject, type Person } from "../../common/objects.js";
import { withIntegrationWorkspaceOwned } from "../../store/operations/integration-workspace/workspace.js";
import {
  iterateOperationTouchedOwned,
  readOperationHeaderOwned,
} from "../../store/operations/operation-journal.js";
import type { OperationTouchedSource } from "../../store/operations/operation-journal-types.js";
import type { GitContext, GitIdentity } from "../core/context.js";
import { requireJournalIdentity, requireJournalMessage } from "../core/journal-input.js";
import type { ReplayEmptyReason, ReplayResult } from "../core/kinds.js";
import { requireSharedMutationScope } from "../core/mutation-scope.js";
import {
  type CherryPickJournal,
  operationKindMismatch,
  operationNotActive,
  operationStepsForState,
  type ReplayKind,
  type ReplayStateMetadata,
  type RevertJournal,
} from "../core/operation-state.js";
import { applyIntegrationOwned } from "../integration/integration-apply-owned.js";
import { restoreIntegrationOwned } from "../integration/integration-restore-owned.js";
import { projectIntegrationStepOwned } from "../integration/integration-step.js";
import {
  integrationIndexMatchesTree,
  requireBoundedIntegrationIndex,
  requireBoundedIntegrationTree,
  requireCleanIntegrationIndex,
} from "../integration/integration-worktree.js";
import { type CommitIdentities, commitIndex } from "../repository/commit.js";
import type { Repository, ResolvedHead } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { planReplayOwned } from "./replay-planning.js";
import type { ReplayIncomingLabelStyle, ReplayPlan } from "./replay-types.js";

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
    source: Commit,
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
): CherryPickJournal<OperationTouchedSource> | RevertJournal<OperationTouchedSource> {
  const journal = readOperationHeaderOwned(repo.checkout);
  if (journal === null) throw operationNotActive(kind);
  if (journal.state.kind !== kind) throw operationKindMismatch(kind, journal.state.kind);
  const fields = {
    steps: operationStepsForState(journal.state),
    replayed: journal.replayed,
    skipped: journal.skipped,
    touched: {
      length: journal.touchedCount,
      [Symbol.iterator]: () => iterateOperationTouchedOwned(repo.checkout)[Symbol.iterator](),
    },
  };
  if (kind === "cherry-pick") {
    if (journal.state.kind !== "cherry-pick") throw operationKindMismatch(kind, journal.state.kind);
    return { kind, state: journal.state, ...fields };
  }
  if (journal.state.kind !== "revert") throw operationKindMismatch(kind, journal.state.kind);
  return { kind, state: journal.state, ...fields };
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
  for (const entry of entries) if (entry.kind === "conflict") return true;
  return false;
}

function requireReplayIdentities(kind: ReplayKind, input: ReplayContinueOptions): void {
  requireJournalIdentity(input.author, "author", kind);
  requireJournalIdentity(input.committer, "committer", kind);
}

export function startReplay(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  input: ReplayStartOptions,
  policy: ReplayPolicy,
): ReplayResult {
  requireSharedMutationScope(repo.store.db, worktree);
  requireReplayIdentities(policy.kind, input);
  return withIntegrationWorkspaceOwned(repo.store, (workspace) => {
    repo.checkout.requireNoOperationState();
    const head = requireReplayHead(repo, policy.kind);
    const currentTree = repo.readCommit(head.oid).tree;
    requireBoundedIntegrationIndex(repo);
    requireCleanIntegrationIndex(repo, currentTree, policy.kind);
    const plan = planReplayOwned(workspace, repo, {
      kind: policy.kind,
      source: input.source,
      currentOid: head.oid,
      mainline: input.mainline,
      incomingLabelStyle: policy.incomingLabelStyle,
    });
    const message = input.message ?? policy.defaultMessage(plan);
    if (plan.integration.entryCount === 0) {
      const reason = emptyReason(plan);
      if (policy.suspendEmpty) {
        requireJournalMessage(message, policy.kind);
        const state = replayState(policy, plan, head, "empty", reason, message, input);
        const steps = operationStepsForState(state);
        writeOperationJournalOwned(repo.checkout, state, steps, []);
      }
      return { outcome: "empty", reason };
    }
    const integration = projectIntegrationStepOwned(workspace, repo, worktree, {
      operation: policy.kind,
      baseTreeOid: plan.baseTreeOid,
      incomingTreeOid: plan.incomingTreeOid,
      plan: plan.integration,
      labels: plan.labels,
      requireResultTree: (entries) => requireBoundedIntegrationTree(repo, entries),
    });
    const conflicted = conflicts(plan.integration.entries);
    const current = repo.head();
    if (current.ref !== head.ref || current.oid !== head.oid) {
      throw new GitError("ESTALEHEAD", `HEAD changed while ${policy.kind} was being prepared`);
    }
    if (conflicted) requireJournalMessage(message, policy.kind);
    const state = conflicted
      ? replayState(policy, plan, head, "conflicted", null, message, input)
      : null;
    applyIntegrationOwned(workspace, repo, worktree, integration, state);
    if (conflicted) return { outcome: "conflicted" };
    const identities = policy.resolveIdentities(context, repo, plan.sourceCommit, input);
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
  requireReplayIdentities(policy.kind, input);
  return repo.store.db.transactionSync(() => {
    const journal = requireReplayJournal(repo, policy.kind);
    const head = requireOriginalHead(repo, journal.state);
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
    if (integrationIndexMatchesTree(repo, repo.readCommit(journal.state.originalHeadOid).tree)) {
      const reason: ReplayEmptyReason = "result";
      if (policy.suspendEmpty) {
        markReplayEmptyOwned(repo.checkout, policy.kind, reason);
      } else {
        checkoutStoreMutations(repo.checkout).clearOperationStateOwned();
      }
      return { outcome: "empty", reason };
    }
    const source = repo.readCommit(journal.state.sourceOid);
    const identities = policy.resolveIdentities(context, repo, source, {
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
  requireSharedMutationScope(repo.store.db, worktree);
  withIntegrationWorkspaceOwned(repo.store, (workspace) => {
    const journal = requireReplayJournal(repo, kind);
    requireOriginalHead(repo, journal.state);
    if (journal.state.phase !== "empty" && journal.touched.length > 0) {
      restoreIntegrationOwned(workspace, repo, worktree, journal.touched);
    }
    checkoutStoreMutations(repo.checkout).clearOperationStateOwned();
  });
}
