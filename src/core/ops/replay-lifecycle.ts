// Shared orchestration for one bounded cherry-pick or revert operation.

import type { MemoryReservation } from "../../memory.js";
import {
  readOperationStateOwned,
  replaceOperationStateOwned,
  writeOperationJournalOwned,
} from "../../sqlite/store.js";
import type { GitContext, GitIdentity } from "../context.js";
import { GitError } from "../errors.js";
import { hashObject, type Person } from "../objects.js";
import type { Repository, ResolvedHead } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import { joinSorted } from "../streams.js";
import type { Worktree } from "../worktree.js";
import { type CommitIdentities, commitIndex } from "./commit.js";
import {
  integrationIndexMatchesTree,
  projectedTouchedShape,
  projectIntegrationWithCollisions,
  prospectiveIntegrationIndexEntries,
  requireBoundedIntegrationIndex,
  requireBoundedIntegrationTree,
  requireCleanIntegrationIndex,
  requireSafeIntegrationWorktree,
  reserveIntegrationPlan,
  retainedTouchedPathSet,
} from "./integration-worktree.js";
import type { ReplayEmptyReason, ReplayResult } from "./kinds.js";
import { applyProjectedOperation, restoreProjectedOperation } from "./merge-apply.js";
import {
  type CherryPickJournal,
  type OperationJournal,
  operationJournalRetainedBytes,
  operationKindMismatch,
  operationNotActive,
  operationStepsForState,
  type ReplayKind,
  type ReplayStateMetadata,
  type RevertJournal,
} from "./operation-state.js";
import { planReplay, type ReplayIncomingLabelStyle, type ReplayPlan } from "./replay.js";
import { treeStream } from "./tree-stream.js";

const EMPTY_TREE_OID = hashObject("tree", new Uint8Array());
const REPLAY_STATE_FIXED_BYTES = 2 * 1024;
const REPLAY_STEP_FIXED_BYTES = 256;
const REPLAY_METADATA_OBJECT_BYTES = 192;

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
  defaultMessage(plan: ReplayPlan, reservation: MemoryReservation): string;
  resolveIdentities(
    context: GitContext,
    repo: Repository,
    plan: ReplayPlan,
    input: ReplayContinueOptions,
  ): CommitIdentities;
}

function checkedReplayBytes(current: number, added: number): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(added) ||
    added < 0 ||
    added > Number.MAX_SAFE_INTEGER - current
  ) {
    throw new GitError("E2BIG", "replay journal memory accounting overflow");
  }
  return current + added;
}

function replayUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", "replay journal text is not canonical UTF-16");
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", "replay journal text is not canonical UTF-16");
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return bytes;
}

function replayIdentityBytes(identity: { name: string; email: string } | null): number {
  return identity === null
    ? 0
    : checkedReplayBytes(replayUtf8Bytes(identity.name), replayUtf8Bytes(identity.email));
}

function replayJournalDraftRetainedBytes(
  policy: ReplayPolicy,
  plan: ReplayPlan,
  head: { ref: string; oid: string },
  message: string,
  input: ReplayStartOptions,
): number {
  let bytes = REPLAY_STATE_FIXED_BYTES;
  for (const value of [head.ref, plan.labels.current, plan.labels.incoming, message]) {
    bytes = checkedReplayBytes(bytes, replayUtf8Bytes(value));
  }
  bytes = checkedReplayBytes(bytes, 40);
  bytes = checkedReplayBytes(
    bytes,
    replayIdentityBytes(
      policy.kind === "cherry-pick" ? plan.sourceCommit.author : (input.author ?? null),
    ),
  );
  bytes = checkedReplayBytes(bytes, replayIdentityBytes(input.committer ?? null));
  bytes = checkedReplayBytes(bytes, REPLAY_STEP_FIXED_BYTES + 40);
  return plan.selectedParentOid === null ? bytes : checkedReplayBytes(bytes, 40);
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
  reservation: MemoryReservation,
): CherryPickJournal | RevertJournal {
  const journal = readOperationStateOwned(repo.checkout, reservation);
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

function replayStateConstructionRetainedBytes(policy: ReplayPolicy): number {
  return policy.kind === "cherry-pick"
    ? REPLAY_METADATA_OBJECT_BYTES * 2
    : REPLAY_METADATA_OBJECT_BYTES;
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
    plan.integration.release();
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
): {
  plan: ReplayPlan;
  reservation: ReturnType<Repository["store"]["reserveMemory"]>;
} {
  requireOriginalSnapshots(repo, journal);
  const plan = planForState(repo, journal.state, incomingLabelStyle);
  let reservation: ReturnType<Repository["store"]["reserveMemory"]>;
  try {
    reservation = reserveIntegrationPlan(repo, plan.integration);
  } catch (error) {
    plan.integration.release();
    throw error;
  }
  const omittedMemory = reservation.scope();
  const shapeMemory = reservation.scope();
  let succeeded = false;
  try {
    const omitted = retainedTouchedPathSet(journal.touched, omittedMemory);
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
      reservation,
    );
    const expected = projectedTouchedShape(projected, shapeMemory);
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
    succeeded = true;
    return { plan, reservation };
  } finally {
    shapeMemory.dispose();
    omittedMemory.dispose();
    if (!succeeded) reservation.dispose();
  }
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
    const reservation = reserveIntegrationPlan(repo, plan.integration);
    const messageMemory = reservation.scope();
    try {
      let message: string;
      if (input.message === undefined) {
        message = policy.defaultMessage(plan, messageMemory);
      } else {
        messageMemory.set("other", retainedStringBytes(input.message));
        message = input.message;
      }
      if (plan.integration.entries.length === 0) {
        const reason = emptyReason(plan);
        if (policy.suspendEmpty) {
          const writeMemory = reservation.scope();
          writeMemory.set(
            "other",
            replayJournalDraftRetainedBytes(policy, plan, head, message, input),
          );
          try {
            const state = replayState(policy, plan, head, "empty", reason, message, input);
            const steps = operationStepsForState(state);
            writeMemory.set("other", operationJournalRetainedBytes(state, [], steps));
            writeOperationJournalOwned(repo.checkout, state, steps, [], writeMemory);
          } finally {
            writeMemory.dispose();
          }
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
        reservation,
      );
      requireSafeIntegrationWorktree(
        repo,
        worktree,
        plan.incomingTreeOid,
        plan.integration.entries,
        policy.kind,
        undefined,
        reservation,
      );
      requireBoundedIntegrationTree(
        repo,
        (owner) => prospectiveIntegrationIndexEntries(repo, projected, owner),
        reservation,
      );
      const conflicted = conflicts(plan.integration.entries);
      const current = repo.head();
      if (current.ref !== head.ref || current.oid !== head.oid) {
        throw new GitError("ESTALEHEAD", `HEAD changed while ${policy.kind} was being prepared`);
      }
      const stateMemory = conflicted ? reservation.scope() : null;
      let state: ReplayStateMetadata | null = null;
      if (stateMemory !== null) {
        stateMemory.set("other", replayStateConstructionRetainedBytes(policy));
        state = replayState(policy, plan, head, "conflicted", null, message, input);
      }
      try {
        applyProjectedOperation(
          repo,
          worktree,
          projected,
          {
            suspendedState: state,
          },
          reservation,
        );
      } finally {
        stateMemory?.dispose();
      }
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
    } finally {
      messageMemory.dispose();
      reservation.dispose();
    }
  });
}

export function continueReplay(
  context: GitContext,
  repo: Repository,
  input: ReplayContinueOptions,
  policy: ReplayPolicy,
): ReplayResult {
  return repo.store.db.transactionSync(() => {
    const journalMemory = repo.store.reserveMemory();
    try {
      const journal = requireReplayJournal(repo, policy.kind, journalMemory);
      const head = requireOriginalHead(repo, journal.state);
      const verified = requireOwnership(repo, context.worktree, journal, policy.incomingLabelStyle);
      const plan = verified.plan;
      try {
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
        requireBoundedIntegrationIndex(repo, verified.reservation);
        if (integrationIndexMatchesTree(repo, plan.currentTreeOid)) {
          const reason: ReplayEmptyReason = "result";
          if (policy.suspendEmpty) {
            const replaceMemory = verified.reservation.scope();
            replaceMemory.set("other", journal.retainedBytes);
            try {
              const nextState: ReplayStateMetadata = {
                ...journal.state,
                phase: "empty",
                emptyReason: reason,
              };
              replaceOperationStateOwned(
                repo.checkout,
                journal.integrityOid,
                nextState,
                replaceMemory,
              );
            } finally {
              replaceMemory.dispose();
            }
          } else {
            repo.checkout.clearOperationState();
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
        repo.checkout.clearOperationState();
        return { outcome: "committed", oid: result.oid };
      } finally {
        verified.reservation.dispose();
      }
    } finally {
      journalMemory.dispose();
    }
  });
}

export function cancelReplay(repo: Repository, worktree: Worktree, kind: ReplayKind): void {
  repo.store.db.transactionSync(() => {
    const journalMemory = repo.store.reserveMemory();
    try {
      const journal = requireReplayJournal(repo, kind, journalMemory);
      requireOriginalHead(repo, journal.state);
      const incomingLabelStyle: ReplayIncomingLabelStyle =
        kind === "cherry-pick" ? "source-subject" : "parent-of-source-subject";
      const verified = requireOwnership(repo, worktree, journal, incomingLabelStyle);
      try {
        if (journal.touched.length > 0) {
          restoreProjectedOperation(repo, worktree, journal, verified.reservation);
        }
        repo.checkout.clearOperationState();
      } finally {
        verified.reservation.dispose();
      }
    } finally {
      journalMemory.dispose();
    }
  });
}
