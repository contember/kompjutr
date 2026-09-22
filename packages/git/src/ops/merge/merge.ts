import { checkoutStoreMutations } from "../../store/core/checkout-mutations-registry.js";
import { repositoryMutations } from "../repository/repository.js";
// Two-head merge orchestration over bounded graph, integration, and apply seams.

import { GitError } from "../../common/errors.js";
import type { ProjectedMergeEntry } from "../../store/operations/integration-workspace/descriptors.js";
import { withIntegrationWorkspaceOwned } from "../../store/operations/integration-workspace/workspace.js";
import type { GitContext, GitIdentity } from "../core/context.js";
import type { MergeResult } from "../core/kinds.js";
import { requireSharedMutationScope } from "../core/mutation-scope.js";
import { operationRefLogMetadata, type RefLogReason } from "../core/ref-log.js";
import { applyIntegrationOwned } from "../integration/integration-apply-owned.js";
import { projectIntegrationWithCollisionsOwned } from "../integration/integration-collisions-owned.js";
import { planIntegrationOwned } from "../integration/integration-plan-owned.js";
import { restoreIntegrationOwned } from "../integration/integration-restore-owned.js";
import { integrationTouched } from "../integration/integration-touched.js";
import {
  prospectiveIntegrationIndexEntriesOwned,
  requireBoundedIntegrationIndex,
  requireBoundedIntegrationTree,
  requireCleanIntegrationIndex,
  requireSafeIntegrationWorktreeOwned,
} from "../integration/integration-worktree.js";
import { type CommitIdentities, commitIndex, resolveIdentity } from "../repository/commit.js";
import type { Repository, ResolvedHead } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { selectMergeBases } from "./merge-base.js";
import { requireJournalOwnership, requireMergeJournalOwned } from "./merge-journal.js";
import {
  type MergeOrigin,
  type MergeStateMetadata,
  validateMergeStateMetadata,
} from "./merge-state.js";
import { commitTree, selectedBaseTreeOwned, type VirtualState } from "./merge-virtual-base.js";

const HEADS = "refs/heads/";
const MAX_MERGE_REVISION_CODE_UNITS = 1_024;

export interface MergeOptions {
  theirs: string;
  ours?: string;
  fastForward?: boolean;
  fastForwardOnly?: boolean;
  message?: string;
  author?: GitIdentity;
  committer?: GitIdentity;
  env?: Record<string, string>;
  /** Leave a clean divergent result staged instead of creating its commit. */
  commit?: boolean;
}

export interface MergeContinueOptions {
  message?: string;
  author?: GitIdentity;
  committer?: GitIdentity;
  env?: Record<string, string>;
}

export type { MergeOrigin } from "./merge-state.js";

export interface MergeBehavior {
  /** Compatibility clients cannot reach native continue/abort after a conflict. */
  persistConflicts?: boolean;
  /** Pull supplies the remote branch label without changing revision lookup. */
  incomingLabel?: string;
  /** Select pull-specific publication reasons without changing merge mechanics. */
  origin?: MergeOrigin;
}

function mergeReason(
  origin: MergeOrigin | undefined,
  phase: "fast-forward" | "commit",
): RefLogReason {
  if (origin === "pull") return phase === "fast-forward" ? "pull: fast-forward" : "pull: merge";
  return phase === "fast-forward" ? "merge: fast-forward" : "merge: commit";
}

function requireMergeRevision(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitError("EINVAL", `merge ${label} revision is required`);
  }
  if (value.length > MAX_MERGE_REVISION_CODE_UNITS) {
    throw new GitError(
      "E2BIG",
      `merge ${label} revision exceeds ${MAX_MERGE_REVISION_CODE_UNITS} code units`,
    );
  }
  return value;
}

function requireCurrentHead(repo: Repository, ours: string | undefined): ResolvedHead {
  const head = repo.head();
  if (head.ref === null) throw new GitError("EDETACHED", "cannot merge with a detached HEAD");
  if (head.oid === null) throw new GitError("ENOCOMMIT", "cannot merge into an unborn branch");
  if (ours === undefined) return head;
  const expanded = ours === "HEAD" ? head.ref : repo.expandRef(ours);
  if (expanded !== head.ref) {
    throw new GitError("EWRONGHEAD", `merge target ${ours} is not the checked-out branch`);
  }
  return head;
}

function shortRef(ref: string): string {
  return ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref;
}

function incomingLabel(repo: Repository, theirs: string, oid: string): string {
  const expanded = repo.expandRef(theirs);
  if (expanded !== null && expanded !== "HEAD") return shortRef(expanded);
  return oid.slice(0, 12);
}

function defaultMessage(label: string): string {
  return `Merge branch '${label}'`;
}

function savedIdentity(identity: GitIdentity | undefined): GitIdentity | null {
  return identity ?? null;
}

function metadata(
  head: ResolvedHead & { ref: string; oid: string },
  incomingOid: string,
  currentLabel: string,
  nextLabel: string,
  options: MergeOptions,
  mergeOrigin: MergeOrigin,
  message: string,
): Omit<MergeStateMetadata, "phase"> {
  return {
    originalHeadRef: head.ref,
    originalHeadOid: head.oid,
    currentParentOid: head.oid,
    incomingParentOid: incomingOid,
    mode: options.commit === false ? "no-commit" : "commit",
    mergeOrigin,
    currentLabel,
    incomingLabel: nextLabel,
    message,
    author: savedIdentity(options.author),
    committer: savedIdentity(options.committer),
  };
}

function* conflictedPaths(entries: Iterable<ProjectedMergeEntry>): Generator<string> {
  for (const entry of entries) {
    if (entry.stages !== null) yield entry.path;
  }
}

function compatibilityConflict(paths: Iterable<string>): GitError {
  const prefix =
    "git merge failed: Automatic merge failed with one or more merge conflicts in the following files: ";
  const suffix = ". Fix conflicts then commit the result.";
  let names = "";
  for (const path of paths) names += `${names === "" ? "" : ", "}${path}`;
  return new GitError("EMERGEFAIL", `${prefix}${names}${suffix}`);
}

function messageWithConflicts(
  supplied: string | undefined,
  nextLabel: string,
  paths: Iterable<string>,
): string {
  const message = supplied ?? defaultMessage(nextLabel);
  let conflicts = "";
  for (const path of paths) conflicts += `#\t${path}\n`;
  if (conflicts === "") return message;
  const body = message.endsWith("\n") ? message : `${message}\n`;
  return `${body}\n# Conflicts:\n${conflicts}`;
}

function validateMergeCommitInput(
  state: MergeStateMetadata,
  message: string,
  identities: CommitIdentities,
): void {
  validateMergeStateMetadata({
    ...state,
    message,
    author: { name: identities.author.name, email: identities.author.email },
    committer: { name: identities.committer.name, email: identities.committer.email },
  });
}

/** Start and either finish or durably suspend one local two-head merge. */
export function merge(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: MergeOptions,
  behavior: MergeBehavior = {},
): MergeResult {
  requireSharedMutationScope(repo.store.db, worktree);
  return mergeOwned(context, repo, worktree, options, behavior);
}

/** Internal merge seam shared with pull. */
export function mergeOwned(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: MergeOptions,
  behavior: MergeBehavior,
): MergeResult {
  requireSharedMutationScope(repo.store.db, worktree);
  return repo.store.db.transactionSync(() =>
    mergeInTransaction(context, repo, worktree, options, behavior),
  );
}

function mergeInTransaction(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: MergeOptions,
  behavior: MergeBehavior,
): MergeResult {
  const theirs = requireMergeRevision(options.theirs, "incoming");
  const ours =
    options.ours === undefined ? undefined : requireMergeRevision(options.ours, "current");
  repo.checkout.requireNoMergeState();
  const rawHead = requireCurrentHead(repo, ours);
  if (rawHead.ref === null || rawHead.oid === null) throw new GitError("ECORRUPT", "invalid HEAD");
  const head = { ref: rawHead.ref, oid: rawHead.oid };
  if (repo.checkout.hasConflicts()) {
    throw new GitError("EUNMERGED", "cannot merge with unmerged index entries");
  }
  const incomingOid = repo.peel(repo.revParse(theirs));
  const selection = selectMergeBases(repo, { currentOid: head.oid, incomingOid });
  if (selection.kind === "already-merged") return { oid: head.oid, alreadyMerged: true };
  if (selection.kind === "shallow") {
    throw new GitError("ESHALLOW", "cannot determine merge base across a shallow boundary");
  }
  if (selection.kind === "unrelated") {
    throw new GitError("EUNRELATED", "refusing to merge unrelated histories");
  }
  if (options.fastForwardOnly === true && selection.kind !== "fast-forward") {
    throw new GitError("ENONFF", "merge is not a fast-forward");
  }
  if (options.fastForwardOnly === true && options.fastForward === false) {
    throw new GitError("EINVAL", "fastForwardOnly conflicts with fastForward: false");
  }

  const currentTree = commitTree(repo, head.oid);
  const nextTree = commitTree(repo, incomingOid);
  const nextLabel =
    behavior.incomingLabel === undefined
      ? incomingLabel(repo, theirs, incomingOid)
      : requireMergeRevision(behavior.incomingLabel, "incoming label");
  const currentLabel = "HEAD";
  const isFastForward = selection.kind === "fast-forward" && options.fastForward !== false;
  const virtualState: VirtualState = { commits: 0 };
  if (!isFastForward) {
    requireBoundedIntegrationIndex(repo);
    requireCleanIntegrationIndex(repo, currentTree, "merge");
  }
  return withIntegrationWorkspaceOwned(repo.store, (workspace) => {
    const baseTree = isFastForward
      ? currentTree
      : selectedBaseTreeOwned(workspace, repo, selection.bases, virtualState);
    const plan = planIntegrationOwned(workspace, {
      baseTreeOid: baseTree,
      currentTreeOid: currentTree,
      incomingTreeOid: nextTree,
      text: { labels: { current: currentLabel, base: "base", incoming: nextLabel } },
    });
    const projected = projectIntegrationWithCollisionsOwned(
      workspace,
      repo,
      worktree,
      baseTree,
      nextTree,
      plan,
      currentLabel,
      nextLabel,
      undefined,
      "merge",
    );
    requireSafeIntegrationWorktreeOwned(repo, worktree, nextTree, plan, "merge", undefined);
    let conflictCount = 0;
    for (const _path of conflictedPaths(projected.entries)) conflictCount++;
    if (conflictCount > 0 && behavior.persistConflicts === false) {
      throw compatibilityConflict(conflictedPaths(projected.entries));
    }
    const touched = integrationTouched(workspace, projected);
    if (!isFastForward) {
      requireBoundedIntegrationTree(repo, () =>
        prospectiveIntegrationIndexEntriesOwned(repo, projected, touched),
      );
    }

    const current = repo.head();
    if (current.ref !== head.ref || current.oid !== head.oid) {
      throw new GitError("ESTALEHEAD", "HEAD changed while the merge was being prepared");
    }
    const retainedMessage = messageWithConflicts(
      options.message,
      nextLabel,
      conflictedPaths(projected.entries),
    );
    const mergeMetadata = metadata(
      head,
      incomingOid,
      currentLabel,
      nextLabel,
      isFastForward ? { ...options, commit: true } : options,
      behavior.origin ?? "merge",
      retainedMessage,
    );
    const outcome =
      conflictCount > 0 ? "conflicted" : mergeMetadata.mode === "no-commit" ? "ready" : "clean";
    if (outcome === "clean") validateMergeStateMetadata({ ...mergeMetadata, phase: "conflicted" });
    applyIntegrationOwned(workspace, repo, worktree, projected, {
      suspendedState:
        outcome === "clean" ? null : { kind: "merge", ...mergeMetadata, phase: outcome },
    });
    if (isFastForward) {
      repositoryMutations(repo).mutateRefsOwned(
        {
          expected: { name: head.ref, target: head.oid },
          puts: [{ name: head.ref, target: incomingOid }],
        },
        operationRefLogMetadata(
          context,
          repo,
          mergeReason(mergeMetadata.mergeOrigin, "fast-forward"),
          {
            identity: options.committer ?? options.author,
            env: options.env,
          },
        ),
      );
      // A failed optional advance leaves a baseline mismatch, which forces the safe full path.
      context.indexTracker?.advanceBaseline?.(repo.checkout.checkoutId, nextTree);
      return { oid: incomingOid, fastForward: true };
    }
    requireBoundedIntegrationIndex(repo);
    if (outcome === "conflicted") {
      return { conflicted: true, pendingCommit: true };
    }
    if (outcome === "ready") return { pendingCommit: true };

    const identities = resolveIdentity(context, repo, options);
    validateMergeCommitInput(
      { ...mergeMetadata, phase: "conflicted" },
      mergeMetadata.message,
      identities,
    );
    return commitIndex(
      repo,
      {
        message: mergeMetadata.message,
        parent: [head.oid, incomingOid],
        identities,
        expectedHead: head,
        refLogReason: mergeReason(mergeMetadata.mergeOrigin, "commit"),
      },
      context,
    );
  });
}

function requireOriginalHead(repo: Repository, state: MergeStateMetadata): ResolvedHead {
  const head = repo.head();
  if (head.ref !== state.originalHeadRef || head.oid !== state.originalHeadOid) {
    throw new GitError("ESTALEHEAD", "HEAD changed during the merge operation");
  }
  return head;
}

/** Commit a fully resolved durable merge after any restart. */
export function mergeContinue(
  context: GitContext,
  repo: Repository,
  options: MergeContinueOptions = {},
): MergeResult {
  return repo.store.db.transactionSync(() => {
    const journal = requireMergeJournalOwned(repo);
    const head = requireOriginalHead(repo, journal.state);
    requireJournalOwnership(repo, context.worktree, journal);
    if (repo.checkout.hasConflicts()) {
      throw new GitError("EUNMERGED", "cannot continue: the index has unmerged paths");
    }
    requireBoundedIntegrationIndex(repo);
    const identities = resolveIdentity(context, repo, {
      author: options.author ?? journal.state.author ?? undefined,
      committer: options.committer ?? journal.state.committer ?? undefined,
      env: options.env,
    });
    const message = options.message ?? journal.state.message;
    validateMergeCommitInput(journal.state, message, identities);
    const result = commitIndex(
      repo,
      {
        message,
        parent: [journal.state.currentParentOid, journal.state.incomingParentOid],
        identities,
        expectedHead: head,
        refLogReason: mergeReason(journal.state.mergeOrigin, "commit"),
      },
      context,
    );
    checkoutStoreMutations(repo.checkout).clearMergeStateOwned();
    return result;
  });
}

/** Restore only paths owned by the active merge and clear its durable state. */
export function mergeAbort(repo: Repository, worktree: Worktree): void {
  requireSharedMutationScope(repo.store.db, worktree);
  repo.store.db.transactionSync(() => {
    const journal = requireMergeJournalOwned(repo);
    requireOriginalHead(repo, journal.state);
    requireJournalOwnership(repo, worktree, journal);
    withIntegrationWorkspaceOwned(repo.store, (workspace) => {
      restoreIntegrationOwned(workspace, repo, worktree, journal.touched, [
        journal.state.originalHeadOid,
        journal.state.currentParentOid,
        journal.state.incomingParentOid,
      ]);
      checkoutStoreMutations(repo.checkout).clearMergeStateOwned();
    });
  });
}
