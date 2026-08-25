// Shared orchestration for one bounded cherry-pick or revert operation.

import type { GitContext, GitIdentity } from "../context.js";
import { GitError } from "../errors.js";
import { hashObject, type Person } from "../objects.js";
import type { Repository, ResolvedHead } from "../repository.js";
import { joinSorted } from "../streams.js";
import type { Worktree } from "../worktree.js";
import { type CommitIdentities, commitIndex } from "./commit.js";
import { MAX_INTEGRATION_TREE_STATEMENTS } from "./integration.js";
import {
  INTEGRATION_COLLISION_SQL_STATEMENTS,
  INTEGRATION_GUARD_SQL_STATEMENTS,
  INTEGRATION_INDEX_SQL_STATEMENTS,
  integrationCommitSqlStatements,
  integrationIndexMatchesTree,
  integrationSqlStatements,
  projectedTouchedShape,
  projectIntegrationWithCollisions,
  prospectiveIntegrationIndexEntries,
  requireBoundedIntegrationIndex,
  requireBoundedIntegrationTree,
  requireCleanIntegrationIndex,
  requireSafeIntegrationWorktree,
  reserveIntegrationPlan,
} from "./integration-worktree.js";
import type { ReplayEmptyReason, ReplayResult } from "./kinds.js";
import { applyProjectedOperation, restoreProjectedOperation } from "./merge-apply.js";
import type {
  CherryPickJournal,
  OperationJournal,
  ReplayKind,
  ReplayStateMetadata,
  RevertJournal,
} from "./operation-state.js";
import { planReplay, type ReplayIncomingLabelStyle, type ReplayPlan } from "./replay.js";
import { treeStream } from "./tree-stream.js";

const EMPTY_TREE_OID = hashObject("tree", new Uint8Array());
const REPLAY_FIXED_SQL_STATEMENTS = 30;
const OPERATION_STATE_TRANSITION_SQL_STATEMENTS = 11;

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
  return kind === "cherry-pick"
    ? repo.store.requireOperationState("cherry-pick")
    : repo.store.requireOperationState("revert");
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

function replayPlanningSqlStatements(plan: ReplayPlan): number {
  return (
    plan.sqlStatements +
    integrationSqlStatements(plan.integration, MAX_INTEGRATION_TREE_STATEMENTS) +
    REPLAY_FIXED_SQL_STATEMENTS
  );
}

function replayStartSqlStatements(plan: ReplayPlan): number {
  return (
    replayPlanningSqlStatements(plan) +
    INTEGRATION_INDEX_SQL_STATEMENTS +
    INTEGRATION_GUARD_SQL_STATEMENTS
  );
}

/** Compose replay recovery work; 999 is valid and 1,000 fails closed. */
export function calculateReplayRecoverySqlStatements(
  ownershipSqlStatements: number,
  transitionSqlStatements: number,
): number {
  if (
    !Number.isSafeInteger(ownershipSqlStatements) ||
    ownershipSqlStatements < 0 ||
    !Number.isSafeInteger(transitionSqlStatements) ||
    transitionSqlStatements < 0 ||
    transitionSqlStatements > 999 - ownershipSqlStatements
  ) {
    return 1_000;
  }
  return ownershipSqlStatements + transitionSqlStatements;
}

function requireSql(total: number): void {
  if (!Number.isSafeInteger(total) || total >= 1_000) {
    throw new GitError("E2BIG", `replay SQL model requires ${total} statements`);
  }
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
): {
  plan: ReplayPlan;
  sqlStatements: number;
  reservation: ReturnType<Repository["store"]["reserveMemory"]>;
} {
  requireOriginalSnapshots(repo, journal);
  const plan = planForState(repo, journal.state, incomingLabelStyle);
  const reservation = reserveIntegrationPlan(repo, plan.integration);
  try {
    const omitted = new Set(journal.touched.map((entry) => entry.path));
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
    const sqlStatements = replayPlanningSqlStatements(plan) + INTEGRATION_COLLISION_SQL_STATEMENTS;
    requireSql(sqlStatements);
    return { plan, sqlStatements, reservation };
  } catch (error) {
    reservation.dispose();
    throw error;
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
    repo.store.requireNoOperationState();
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
    const prior = replayStartSqlStatements(plan);
    const reservation = reserveIntegrationPlan(repo, plan.integration);
    try {
      if (plan.integration.entries.length === 0) {
        requireSql(prior);
        const reason = emptyReason(plan);
        if (policy.suspendEmpty) {
          repo.store.writeOperationState(
            replayState(policy, plan, head, "empty", reason, message, input),
            [],
          );
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
        new Set(),
        policy.kind,
      );
      let sql = prior;
      if (projected.some((entry) => entry.purpose !== "primary")) {
        sql += INTEGRATION_COLLISION_SQL_STATEMENTS;
      }
      requireSafeIntegrationWorktree(
        repo,
        worktree,
        plan.incomingTreeOid,
        plan.integration.entries.map((entry) => entry.path),
        policy.kind,
      );
      const treeStats = requireBoundedIntegrationTree(
        prospectiveIntegrationIndexEntries(repo, projected),
      );
      const conflicted = conflicts(plan.integration.entries);
      if (!conflicted) sql += integrationCommitSqlStatements(treeStats);
      requireSql(sql);
      const current = repo.head();
      if (current.ref !== head.ref || current.oid !== head.oid) {
        throw new GitError("ESTALEHEAD", `HEAD changed while ${policy.kind} was being prepared`);
      }
      const state = conflicted
        ? replayState(policy, plan, head, "conflicted", null, message, input)
        : null;
      applyProjectedOperation(repo, worktree, projected, {
        priorSqlStatements: sql,
        suspendedState: state,
      });
      if (conflicted) return { outcome: "conflicted" };
      const identities = policy.resolveIdentities(context, repo, plan, input);
      const result = commitIndex(repo, {
        message,
        parent: [head.oid],
        identities,
        expectedHead: head,
      });
      return { outcome: "committed", oid: result.oid };
    } finally {
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
    const journal = requireReplayJournal(repo, policy.kind);
    const head = requireOriginalHead(repo, journal.state);
    const verified = requireOwnership(repo, context.worktree, journal, policy.incomingLabelStyle);
    const plan = verified.plan;
    try {
      if (journal.state.phase === "empty") {
        requireSql(verified.sqlStatements);
        const reason = journal.state.emptyReason;
        if (reason === null) throw new GitError("ECORRUPT", "empty replay lost its reason");
        return { outcome: "empty", reason };
      }
      if (repo.store.hasConflicts()) {
        throw new GitError(
          "EUNMERGED",
          `cannot continue ${policy.kind}: the index has unmerged paths`,
        );
      }
      const treeStats = requireBoundedIntegrationIndex(repo);
      if (integrationIndexMatchesTree(repo, plan.currentTreeOid)) {
        requireSql(
          calculateReplayRecoverySqlStatements(
            verified.sqlStatements,
            INTEGRATION_INDEX_SQL_STATEMENTS * 2 + OPERATION_STATE_TRANSITION_SQL_STATEMENTS,
          ),
        );
        const reason: ReplayEmptyReason = "result";
        if (policy.suspendEmpty) {
          repo.store.replaceOperationState(journal.integrityOid, {
            ...journal.state,
            phase: "empty",
            emptyReason: reason,
          });
        } else {
          repo.store.clearOperationState();
        }
        return { outcome: "empty", reason };
      }
      const identities = policy.resolveIdentities(context, repo, plan, {
        message: input.message,
        author: input.author ?? journal.state.author ?? undefined,
        committer: input.committer ?? journal.state.committer ?? undefined,
        env: input.env,
      });
      requireSql(
        calculateReplayRecoverySqlStatements(
          verified.sqlStatements,
          INTEGRATION_INDEX_SQL_STATEMENTS * 2 +
            integrationCommitSqlStatements(treeStats) +
            OPERATION_STATE_TRANSITION_SQL_STATEMENTS,
        ),
      );
      const result = commitIndex(repo, {
        message: input.message ?? journal.state.message,
        parent: [journal.state.originalHeadOid],
        identities,
        expectedHead: head,
      });
      repo.store.clearOperationState();
      return { outcome: "committed", oid: result.oid };
    } finally {
      verified.reservation.dispose();
    }
  });
}

export function cancelReplay(repo: Repository, worktree: Worktree, kind: ReplayKind): void {
  repo.store.db.transactionSync(() => {
    const journal = requireReplayJournal(repo, kind);
    requireOriginalHead(repo, journal.state);
    const incomingLabelStyle: ReplayIncomingLabelStyle =
      kind === "cherry-pick" ? "source-subject" : "parent-of-source-subject";
    const verified = requireOwnership(repo, worktree, journal, incomingLabelStyle);
    try {
      if (journal.touched.length > 0) {
        restoreProjectedOperation(repo, worktree, journal, {
          priorSqlStatements: verified.sqlStatements,
          clearState: true,
        });
      } else {
        requireSql(
          calculateReplayRecoverySqlStatements(
            verified.sqlStatements,
            OPERATION_STATE_TRANSITION_SQL_STATEMENTS,
          ),
        );
      }
      repo.store.clearOperationState();
    } finally {
      verified.reservation.dispose();
    }
  });
}
