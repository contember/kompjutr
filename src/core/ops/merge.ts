// Two-head merge orchestration over bounded graph, integration, and apply seams.

import type { IndexEntry, ObjectBatch } from "../../sqlite/store.js";
import type { GitContext, GitIdentity } from "../context.js";
import { GitError } from "../errors.js";
import { hashObject, serializeCommit } from "../objects.js";
import type { Repository, ResolvedHead } from "../repository.js";
import { joinSorted } from "../streams.js";
import type { Worktree } from "../worktree.js";
import { type CommitIdentities, commitIndex, resolveIdentity } from "./commit.js";
import {
  type IntegrationPlan,
  planIntegration,
  planVirtualAncestorIntegration,
} from "./integration.js";
import {
  projectedTouchedShape,
  projectIntegrationWithCollisions,
  prospectiveIntegrationIndexEntries,
  requireBoundedIntegrationIndex,
  requireBoundedIntegrationTree,
  requireCleanIntegrationIndex,
  requireSafeIntegrationWorktree,
  reserveIntegrationExecution,
  reserveIntegrationPlan,
} from "./integration-worktree.js";
import type { MergeResult } from "./kinds.js";
import { abortProjectedMerge, applyProjectedMerge } from "./merge-apply.js";
import { selectMergeBases } from "./merge-base.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import {
  type MergeJournal,
  type MergeOrigin,
  type MergeStateMetadata,
  type MergeTouchedPath,
  validateMergeStateMetadata,
} from "./merge-state.js";
import { operationRefLogMetadata, type RefLogReason } from "./ref-log.js";
import { buildTreeInBatch } from "./tree-build.js";
import { treeStream } from "./tree-stream.js";

const HEADS = "refs/heads/";
const MAX_MERGE_REVISION_CODE_UNITS = 1_024;
const MAX_VIRTUAL_COMMITS = 1;
const VIRTUAL_IDENTITY = {
  name: "git merge-recursive",
  email: "merge-recursive@localhost",
  timestamp: 0,
  timezoneOffset: 0,
};

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

function commitTree(repo: Repository, oid: string): string {
  return repo.readCommit(oid).tree;
}

interface VirtualState {
  commits: number;
}

function indexEntry(path: string, mode: string, oid: string): IndexEntry {
  return {
    path,
    stage: 0,
    mode: Number.parseInt(mode, 8),
    oid,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  };
}

function* virtualTreeEntries(
  repo: Repository,
  batch: ObjectBatch,
  currentTree: string,
  plan: IntegrationPlan,
): Generator<IndexEntry> {
  for (const row of joinSorted(treeStream(repo, currentTree), plan.entries, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const planned = row.right;
    if (planned === undefined) {
      const current = row.left;
      if (current === undefined) throw new GitError("ECORRUPT", "virtual tree row is empty");
      yield indexEntry(current.path, current.mode, current.oid);
      continue;
    }
    if (planned.kind !== "clean") {
      throw new GitError("ECORRUPT", "virtual integration retained a conflict");
    }
    const result = planned.result;
    if (result === null) continue;
    if (planned.content !== null) {
      const oid = batch.write("blob", planned.content);
      if (oid !== result.oid || hashObject("blob", planned.content) !== result.oid) {
        throw new GitError("ECORRUPT", `virtual content identity differs at ${planned.path}`);
      }
    }
    yield indexEntry(planned.path, result.mode, result.oid);
  }
}

function materializeVirtualCommit(
  repo: Repository,
  currentOid: string,
  incomingOid: string,
  plan: IntegrationPlan,
): string {
  const currentTree = commitTree(repo, currentOid);
  return repo.store.writeObjects((batch) => {
    const tree = buildTreeInBatch(batch, virtualTreeEntries(repo, batch, currentTree, plan));
    return batch.write(
      "commit",
      serializeCommit({
        tree,
        parent: [currentOid, incomingOid],
        author: VIRTUAL_IDENTITY,
        committer: VIRTUAL_IDENTITY,
        message: "virtual merge base\n",
      }),
    );
  });
}

function requireBoundedVirtualTree(
  repo: Repository,
  currentOid: string,
  plan: IntegrationPlan,
): void {
  const currentTree = commitTree(repo, currentOid);
  requireBoundedIntegrationTree(virtualTreeEntries(repo, batchForIdentity(), currentTree, plan));
}

function batchForIdentity(): ObjectBatch {
  return {
    write: (type, data) => hashObject(type, data),
    flush() {},
  };
}

function synthesizeVirtualPair(
  repo: Repository,
  currentOid: string,
  incomingOid: string,
  state: VirtualState,
  depth: number,
): string {
  const selection = selectMergeBases(repo, { currentOid, incomingOid });
  if (selection.kind === "already-merged") return currentOid;
  if (selection.kind === "fast-forward") return incomingOid;
  if (selection.kind === "shallow") {
    throw new GitError("ESHALLOW", "cannot synthesize a merge base across a shallow boundary");
  }
  if (selection.kind === "unrelated") {
    throw new GitError("EUNRELATED", "cannot synthesize unrelated merge bases");
  }
  state.commits++;
  if (state.commits > MAX_VIRTUAL_COMMITS) {
    throw new GitError(
      "E2BIG",
      `recursive merge-base synthesis exceeds ${MAX_VIRTUAL_COMMITS} temporary commits`,
    );
  }
  const baseCommit = synthesizeVirtualBases(repo, selection.bases, state, depth + 1);
  const plan = planVirtualAncestorIntegration(repo, {
    baseTreeOid: commitTree(repo, baseCommit),
    currentTreeOid: commitTree(repo, currentOid),
    incomingTreeOid: commitTree(repo, incomingOid),
    labels: { current: "Temporary merge branch 1", incoming: "Temporary merge branch 2" },
    depth,
  });
  const reservation = reserveIntegrationPlan(repo, plan);
  try {
    requireBoundedVirtualTree(repo, currentOid, plan);
    return materializeVirtualCommit(repo, currentOid, incomingOid, plan);
  } finally {
    reservation.dispose();
  }
}

function synthesizeVirtualBases(
  repo: Repository,
  bases: readonly string[],
  state: VirtualState,
  depth: number,
): string {
  const first = bases[0];
  if (first === undefined) throw new GitError("EUNRELATED", "merge base list is empty");
  let current = first;
  for (let index = 1; index < bases.length; index++) {
    const incoming = bases[index];
    if (incoming === undefined) throw new GitError("ECORRUPT", "merge base list has a hole");
    current = synthesizeVirtualPair(repo, current, incoming, state, depth);
  }
  return current;
}

function selectedBaseTree(repo: Repository, bases: readonly string[], state: VirtualState): string {
  return commitTree(repo, synthesizeVirtualBases(repo, bases, state, 1));
}

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

function requireJournalOwnership(
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
  const reservation = reserveIntegrationPlan(repo, plan);
  try {
    const omitted = new Set(journal.touched.map((entry) => entry.path));
    const projected = projectIntegrationWithCollisions(
      repo,
      worktree,
      baseTree,
      incomingTree,
      plan,
      state.currentLabel,
      state.incomingLabel,
      omitted,
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
  } finally {
    reservation.dispose();
  }
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
    message: options.message ?? defaultMessage(nextLabel),
    author: savedIdentity(options.author),
    committer: savedIdentity(options.committer),
  };
}

function conflictedPaths(entries: readonly ProjectedMergeEntry[]): string[] {
  return entries.flatMap((entry) => (entry.stages === null ? [] : [entry.path]));
}

function compatibilityConflict(paths: readonly string[]): GitError {
  return new GitError(
    "EMERGEFAIL",
    `git merge failed: Automatic merge failed with one or more merge conflicts in the following files: ${paths.join(", ")}. Fix conflicts then commit the result.`,
  );
}

function messageWithConflicts(message: string, paths: readonly string[]): string {
  if (paths.length === 0) return message;
  const body = message.endsWith("\n") ? message : `${message}\n`;
  return `${body}\n# Conflicts:\n${paths.map((path) => `#\t${path}\n`).join("")}`;
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
  const baseTree = isFastForward
    ? currentTree
    : selectedBaseTree(repo, selection.bases, virtualState);
  const plan = planIntegration(repo, {
    baseTreeOid: baseTree,
    currentTreeOid: currentTree,
    incomingTreeOid: nextTree,
    text: { labels: { current: currentLabel, base: "base", incoming: nextLabel } },
  });
  const reservation = reserveIntegrationPlan(repo, plan);
  try {
    const projected = projectIntegrationWithCollisions(
      repo,
      worktree,
      baseTree,
      nextTree,
      plan,
      currentLabel,
      nextLabel,
    );
    requireSafeIntegrationWorktree(
      repo,
      worktree,
      nextTree,
      plan.entries.map((entry) => entry.path),
      "merge",
    );
    const conflicts = conflictedPaths(projected);
    if (conflicts.length > 0 && behavior.persistConflicts === false) {
      throw compatibilityConflict(conflicts);
    }
    if (!isFastForward) {
      requireBoundedIntegrationTree(prospectiveIntegrationIndexEntries(repo, projected));
    }

    const current = repo.head();
    if (current.ref !== head.ref || current.oid !== head.oid) {
      throw new GitError("ESTALEHEAD", "HEAD changed while the merge was being prepared");
    }
    const mergeMetadata = metadata(
      head,
      incomingOid,
      currentLabel,
      nextLabel,
      isFastForward ? { ...options, commit: true } : options,
      behavior.origin ?? "merge",
    );
    mergeMetadata.message = messageWithConflicts(mergeMetadata.message, conflicts);
    const applied = applyProjectedMerge(repo, worktree, projected, mergeMetadata);
    if (isFastForward) {
      repo.mutateRefs(
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
    if (applied.outcome === "conflicted") {
      return { conflicted: true, pendingCommit: true };
    }
    if (applied.outcome === "ready") return { pendingCommit: true };

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
  } finally {
    reservation.dispose();
  }
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
    const journal = repo.checkout.requireMergeState();
    const head = requireOriginalHead(repo, journal.state);
    requireJournalOwnership(repo, context.worktree, journal);
    if (repo.checkout.hasConflicts()) {
      throw new GitError("EUNMERGED", "cannot continue: the index has unmerged paths");
    }
    requireBoundedIntegrationIndex(repo);
    const reservation = reserveIntegrationExecution(repo);
    try {
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
      repo.checkout.clearMergeState();
      return result;
    } finally {
      reservation.dispose();
    }
  });
}

/** Restore only paths owned by the active merge and clear its durable state. */
export function mergeAbort(repo: Repository, worktree: Worktree): void {
  repo.store.db.transactionSync(() => {
    const journal = repo.checkout.requireMergeState();
    requireOriginalHead(repo, journal.state);
    requireJournalOwnership(repo, worktree, journal);
    const reservation = reserveIntegrationExecution(repo);
    try {
      abortProjectedMerge(repo, worktree, journal);
    } finally {
      reservation.dispose();
    }
  });
}
