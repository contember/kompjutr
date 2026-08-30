// Restart-safe execution of one authenticated linear rebase sequence.

import type { IndexEntry } from "../../sqlite/store.js";
import { utf8 } from "../bytes.js";
import type { GitContext, GitIdentity } from "../context.js";
import { CorruptError, GitError } from "../errors.js";
import { relativeTo } from "../paths.js";
import type { Repository } from "../repository.js";
import { comparePaths, joinSorted } from "../streams.js";
import type { Worktree } from "../worktree.js";
import { checkoutTree, checkoutTreeExcluding } from "./checkout.js";
import { resolveIdentity, writeUnpublishedCommit } from "./commit.js";
import {
  integrationIndexMatchesTree,
  projectedTouchedShape,
  projectIntegrationWithCollisions,
  prospectiveIntegrationIndexEntries,
  requireBoundedIntegrationIndex,
  requireBoundedIntegrationTree,
  requireCleanIntegrationIndex,
  requireCleanIntegrationWorktree,
  requireSafeIntegrationWorktree,
  reserveIntegrationPlan,
} from "./integration-worktree.js";
import type { RebaseResult } from "./kinds.js";
import { applyProjectedRebaseTransition } from "./merge-apply.js";
import { selectMergeBases } from "./merge-base.js";
import type {
  OperationStepMetadata,
  RebaseJournal,
  RebaseStateMetadata,
} from "./operation-state.js";
import { planRebase } from "./rebase-plan.js";
import { operationRefLogMetadata, persistedRefLogMetadata } from "./ref-log.js";
import {
  type CheckoutBlockerLimits,
  checkoutBlockersAgainst,
  hardResetBlockersAgainst,
} from "./refs.js";
import {
  planRetainedFixedReplayStep,
  preflightReplayCommitObjects,
  type ReplayPlan,
  type RetainedReplayPlan,
} from "./replay.js";
import { treeStream } from "./tree-stream.js";

const REBASE_BASELINE_MAX_ENTRIES = 4_096;
const REBASE_BASELINE_MAX_BYTES = 32 * 1024 * 1024;
const REBASE_INTEGRATION_PLAN_BYTES = 20 * 1024 * 1024;
const REBASE_EXCLUDE_ROOTS = 64;
const REBASE_EXCLUDE_BYTES = 1024 * 1024;

export interface RebaseStartOptions {
  upstream: string;
  committer?: GitIdentity;
  env?: Record<string, string>;
}

export interface RebaseContinueOptions {
  committer?: GitIdentity;
  env?: Record<string, string>;
}

export type RebaseLifecycleResult = RebaseResult;

interface RebaseExclusions {
  absolute: string[];
  relative: string[];
}

const NO_REBASE_EXCLUSIONS: RebaseExclusions = { absolute: [], relative: [] };

function rebaseExclusions(repo: Repository, roots: readonly string[]): RebaseExclusions {
  if (roots.length > REBASE_EXCLUDE_ROOTS) {
    throw new GitError("E2BIG", `rebase exclusions exceed ${REBASE_EXCLUDE_ROOTS} roots`);
  }
  const absolute: string[] = [];
  const relative: string[] = [];
  let retainedBytes = 0;
  for (const root of roots) {
    const path = relativeTo(repo.root, root);
    if (path === null || path === "") {
      throw new GitError("EINVAL", `rebase exclusion ${root} is not nested under ${repo.root}`);
    }
    retainedBytes += utf8.encode(root).byteLength + utf8.encode(path).byteLength;
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes > REBASE_EXCLUDE_BYTES) {
      throw new GitError("E2BIG", `rebase exclusions exceed ${REBASE_EXCLUDE_BYTES} bytes`);
    }
    if (relative.includes(path)) continue;
    absolute.push(root);
    relative.push(path);
  }
  absolute.sort(comparePaths);
  relative.sort(comparePaths);
  return { absolute, relative };
}

function requirePathsOutsideExclusions(
  paths: Iterable<string>,
  exclusions: RebaseExclusions,
): void {
  for (const path of paths) {
    for (const root of exclusions.relative) {
      if (path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`)) {
        throw new GitError("ECHECKOUTFAIL", `rebase would change foreign checkout path ${path}`);
      }
    }
  }
}

function requireRebaseIndex(repo: Repository) {
  const stats = requireBoundedIntegrationIndex(repo);
  if (stats.leafEntries > REBASE_BASELINE_MAX_ENTRIES) {
    throw new GitError("E2BIG", `rebase index exceeds ${REBASE_BASELINE_MAX_ENTRIES} entries`);
  }
  return stats;
}

function requireRebaseTree(
  repo: Repository,
  entries: Parameters<typeof requireBoundedIntegrationTree>[1],
) {
  const stats = requireBoundedIntegrationTree(repo, entries);
  if (stats.leafEntries > REBASE_BASELINE_MAX_ENTRIES) {
    throw new GitError("E2BIG", `rebase result exceeds ${REBASE_BASELINE_MAX_ENTRIES} entries`);
  }
  return stats;
}

function requireHead(repo: Repository): { ref: string; oid: string } {
  const head = repo.head();
  if (head.ref === null) throw new GitError("EDETACHED", "cannot rebase with a detached HEAD");
  if (!head.ref.startsWith("refs/heads/")) {
    throw new GitError("EWRONGHEAD", "cannot rebase: HEAD is not a checked-out local branch");
  }
  if (head.oid === null) throw new GitError("ENOCOMMIT", "cannot rebase an unborn branch");
  return { ref: head.ref, oid: head.oid };
}

function requireOriginalHead(repo: Repository, state: RebaseStateMetadata): void {
  const head = repo.head();
  if (head.ref !== state.originalHeadRef || head.oid !== state.originalHeadOid) {
    throw new GitError("ESTALEHEAD", "HEAD changed during the rebase operation");
  }
}

function sameQueueStep(left: OperationStepMetadata, right: OperationStepMetadata): boolean {
  return (
    left.sourceOid === right.sourceOid &&
    left.selectedParentOid === right.selectedParentOid &&
    left.mainline === right.mainline
  );
}

function requireResumedTopology(repo: Repository, journal: RebaseJournal): void {
  const selection = selectMergeBases(repo, {
    currentOid: journal.state.originalHeadOid,
    incomingOid: journal.state.upstreamOid,
  });
  if (
    selection.kind !== "divergent" ||
    selection.bases.length !== 1 ||
    selection.bases[0] !== journal.state.baseOid
  ) {
    throw new GitError("ECORRUPT", "rebase topology differs from its authenticated base");
  }
}

function requireCurrentBaseline(
  repo: Repository,
  worktree: Worktree,
  state: RebaseStateMetadata,
  exclusions: RebaseExclusions,
): string {
  const tree = repo.readCommit(state.currentParentOid).tree;
  requireRebaseIndex(repo);
  if (!integrationIndexMatchesTree(repo, tree)) {
    throw new GitError("ECHECKOUTFAIL", "rebase index differs from its current replay parent");
  }
  requireCleanIntegrationWorktree(repo, worktree, "rebase", exclusions.absolute);
  return tree;
}

function materializeTree(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string,
  target: BaselineTransition,
): void {
  const blockers = checkoutBlockersAgainst(
    repo,
    worktree,
    baselineTree,
    target.treeOid,
    undefined,
    true,
    checkoutGuardLimits(),
  );
  if (blockers.tracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `local changes to ${blockers.tracked.join(", ")} would be overwritten by rebase`,
    );
  }
  if (blockers.untracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `untracked working tree files would be overwritten by rebase: ${blockers.untracked.join(", ")}`,
    );
  }
  checkoutTree(repo, worktree, target.treeOid, {
    preserveMatchingIndex: true,
    maxWorktreeRowsPerPass: 50_000,
  });
}

interface BaselineTransition {
  treeOid: string;
}

function checkoutGuardLimits(): CheckoutBlockerLimits {
  return {
    maxRows: 50_000,
    maxHashBytes: REBASE_BASELINE_MAX_BYTES,
    rows: 0,
    hashBytes: 0,
    maxHashCandidates: REBASE_BASELINE_MAX_ENTRIES,
    hashCandidates: 0,
  };
}

function hardMaterializeTree(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string,
  target: BaselineTransition,
  exclusions: RebaseExclusions,
): void {
  const blockers = hardResetBlockersAgainst(
    repo,
    worktree,
    baselineTree,
    target.treeOid,
    checkoutGuardLimits(),
    exclusions.absolute,
  );
  if (blockers.untracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `untracked working tree files would be overwritten by rebase: ${blockers.untracked.join(", ")}`,
    );
  }
  checkoutTreeExcluding(repo, worktree, target.treeOid, exclusions.absolute, {
    preserveMatchingIndex: false,
    restoreStructure: true,
    discardUnmerged: true,
    maxWorktreeRowsPerPass: 50_000,
  });
}

function preflightBaselineTransition(repo: Repository, treeOid: string): BaselineTransition {
  const oids: string[] = [];
  const entries = function* (): Generator<IndexEntry> {
    for (const entry of treeStream(repo, treeOid)) {
      if (entry.mode === "160000") {
        throw new GitError("EUNSUPPORTED", `rebase cannot materialize gitlink ${entry.path}`);
      }
      if (oids.length >= REBASE_BASELINE_MAX_ENTRIES) {
        throw new GitError(
          "E2BIG",
          `rebase baseline exceeds ${REBASE_BASELINE_MAX_ENTRIES} entries`,
        );
      }
      oids.push(entry.oid);
      yield {
        path: entry.path,
        stage: 0,
        mode: Number.parseInt(entry.mode, 8),
        oid: entry.oid,
        size: null,
        mtime: null,
        ino: null,
        rev: null,
      };
    }
  };
  requireRebaseTree(repo, entries());
  const unique = new Set(oids);
  const sizes = new Map<string, number>();
  for (const object of repo.store.objectInfo([...unique])) {
    if (object.type !== "blob") {
      throw new CorruptError(`rebase baseline object ${object.oid} is not a blob`);
    }
    sizes.set(object.oid, object.size);
  }
  let blobBytes = 0;
  for (const oid of oids) {
    const size = sizes.get(oid);
    if (size === undefined) throw new CorruptError(`rebase baseline lost blob ${oid}`);
    if (size > REBASE_BASELINE_MAX_BYTES - blobBytes) {
      throw new GitError(
        "E2BIG",
        `rebase baseline exceeds ${REBASE_BASELINE_MAX_BYTES} blob bytes`,
      );
    }
    blobBytes += size;
  }
  return { treeOid };
}

function initialState(
  head: { ref: string; oid: string },
  upstreamOid: string,
  baseOid: string,
  committer: GitIdentity | null,
): RebaseStateMetadata {
  return {
    kind: "rebase",
    phase: "running",
    originalHeadRef: head.ref,
    originalHeadOid: head.oid,
    upstreamOid,
    baseOid,
    currentParentOid: upstreamOid,
    currentStep: 0,
    currentLabel: "HEAD",
    incomingLabel: "REBASE_HEAD",
    message: "",
    author: null,
    committer,
  };
}

function completedCounts(steps: readonly OperationStepMetadata[]): {
  replayed: number;
  skipped: number;
} {
  let replayed = 0;
  let skipped = 0;
  for (const step of steps) {
    if (step.outcome === "applied") replayed++;
    else if (step.outcome === "skipped") skipped++;
  }
  return { replayed, skipped };
}

function nextSteps(
  journal: RebaseJournal,
  outcome: "applied" | "skipped",
  resultOid: string | null,
): readonly OperationStepMetadata[] {
  return journal.steps.map((step, ordinal) =>
    ordinal === journal.state.currentStep ? { ...step, outcome, resultOid } : step,
  );
}

function advance(
  repo: Repository,
  journal: RebaseJournal,
  outcome: "applied" | "skipped",
  resultOid: string | null,
  committer?: GitIdentity,
): void {
  const steps = nextSteps(journal, outcome, resultOid);
  repo.checkout.replaceOperationJournal(
    journal.integrityOid,
    {
      ...journal.state,
      phase: "running",
      currentStep: journal.state.currentStep + 1,
      currentParentOid: resultOid ?? journal.state.currentParentOid,
      committer: committer ?? journal.state.committer,
    },
    steps,
    [],
  );
}

function planCurrentStep(
  repo: Repository,
  journal: RebaseJournal,
  callerRetainedBytes = 0,
): RetainedReplayPlan {
  const step = journal.steps[journal.state.currentStep];
  if (step === undefined || step.outcome !== "pending") {
    throw new CorruptError("rebase current step is not pending");
  }
  const retained = planRetainedFixedReplayStep(repo, {
    sourceOid: step.sourceOid,
    selectedParentOid: step.selectedParentOid,
    currentOid: journal.state.currentParentOid,
    callerRetainedBytes,
    limits: { maxPlanBytes: REBASE_INTEGRATION_PLAN_BYTES },
  });
  const plan = retained.plan;
  if (
    !sameQueueStep(step, {
      sourceOid: plan.sourceOid,
      selectedParentOid: plan.selectedParentOid,
      mainline: plan.mainline,
      outcome: "pending",
      resultOid: null,
    })
  ) {
    retained.release();
    throw new CorruptError("rebase replay plan differs from its current journal step");
  }
  return retained;
}

function sourceIsEmpty(plan: ReplayPlan): boolean {
  return plan.sourceTreeOid === plan.selectedParentTreeOid;
}

function stepIdentities(
  context: GitContext,
  repo: Repository,
  plan: ReplayPlan,
  options: RebaseContinueOptions,
) {
  return resolveIdentity(
    context,
    repo,
    { committer: options.committer, env: options.env },
    plan.sourceCommit,
  );
}

function applyOneStep(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  expectedIntegrityOid: string,
  options: RebaseContinueOptions,
  exclusions: RebaseExclusions,
): "advanced" | "conflicted" {
  return repo.store.db.transactionSync(() => {
    const journal = repo.checkout.requireOperationState("rebase");
    if (journal.integrityOid !== expectedIntegrityOid) {
      throw new GitError("EOPMISMATCH", "rebase operation changed before replay");
    }
    requireOriginalHead(repo, journal.state);
    if (journal.state.phase !== "running") return "conflicted";
    const currentTree = requireCurrentBaseline(repo, worktree, journal.state, exclusions);
    const journalReservation = repo.store.reserveMemory();
    journalReservation.set("other", journal.retainedBytes);
    try {
      const retainedPlan = planCurrentStep(repo, journal, journal.retainedBytes);
      try {
        const plan = retainedPlan.plan;
        const planReservation = reserveIntegrationPlan(repo, plan.integration);
        try {
          requireRebaseIndex(repo);
          if (sourceIsEmpty(plan)) {
            const identities = stepIdentities(context, repo, plan, options);
            const result = writeUnpublishedCommit(repo, {
              message: plan.sourceCommit.message,
              parent: [journal.state.currentParentOid],
              identities,
            });
            advance(repo, journal, "applied", result.oid, identities.committer);
            return "advanced";
          }
          if (plan.integration.entries.length === 0) {
            advance(repo, journal, "skipped", null);
            return "advanced";
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
            "rebase",
          );
          for (const entry of projected) {
            requirePathsOutsideExclusions([entry.path, entry.logicalPath], exclusions);
          }
          requireSafeIntegrationWorktree(
            repo,
            worktree,
            plan.incomingTreeOid,
            plan.integration.entries.map((entry) => entry.path),
            "rebase",
            currentTree,
          );
          requireRebaseTree(repo, (reservation) =>
            prospectiveIntegrationIndexEntries(repo, projected, reservation),
          );
          const conflicted = plan.integration.entries.some((entry) => entry.kind === "conflict");
          const transition = applyProjectedRebaseTransition<"advanced">(repo, worktree, projected, {
            expectedIntegrityOid: journal.integrityOid,
            conflictState: conflicted ? { ...journal.state, phase: "conflicted" } : null,
            steps: journal.steps,
            onClean: () => {
              if (integrationIndexMatchesTree(repo, currentTree)) {
                advance(repo, journal, "skipped", null);
                return "advanced";
              }
              const identities = stepIdentities(context, repo, plan, options);
              const result = writeUnpublishedCommit(repo, {
                message: plan.sourceCommit.message,
                parent: [journal.state.currentParentOid],
                identities,
              });
              advance(repo, journal, "applied", result.oid, identities.committer);
              return "advanced";
            },
          });
          return transition.outcome === "conflicted" ? "conflicted" : transition.value;
        } finally {
          planReservation.dispose();
        }
      } finally {
        retainedPlan.release();
      }
    } finally {
      journalReservation.dispose();
    }
  });
}

function requireConflictOwnership(
  repo: Repository,
  worktree: Worktree,
  journal: RebaseJournal,
): void {
  requireConflictSnapshots(repo, journal);
  const journalReservation = repo.store.reserveMemory();
  journalReservation.set("other", journal.retainedBytes);
  try {
    const retainedPlan = planCurrentStep(repo, journal, journal.retainedBytes);
    try {
      const plan = retainedPlan.plan;
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
          "rebase",
        );
        const expected = projectedTouchedShape(projected);
        if (expected.length !== journal.touched.length) {
          throw new CorruptError("rebase conflict ownership is incomplete");
        }
        for (let ordinal = 0; ordinal < expected.length; ordinal++) {
          const left = expected[ordinal];
          const right = journal.touched[ordinal];
          if (
            left === undefined ||
            right === undefined ||
            left.path !== right.path ||
            left.logicalPath !== right.logicalPath ||
            left.purpose !== right.purpose
          ) {
            throw new CorruptError("rebase conflict ownership differs from its replay plan");
          }
        }
      } finally {
        reservation.dispose();
      }
    } finally {
      retainedPlan.release();
    }
  } finally {
    journalReservation.dispose();
  }
}

function requireConflictSnapshots(repo: Repository, journal: RebaseJournal): void {
  const currentTree = repo.readCommit(journal.state.currentParentOid).tree;
  for (const row of joinSorted(treeStream(repo, currentTree), journal.touched, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const saved = row.right;
    if (saved === undefined) continue;
    const expected = row.left;
    if (expected === undefined) {
      if (
        saved.index !== null ||
        (saved.worktree.kind !== "absent" && saved.worktree.kind !== "directory")
      ) {
        throw new CorruptError(`rebase snapshot differs from its current parent at ${saved.path}`);
      }
      continue;
    }
    if (
      saved.index === null ||
      saved.index.stage !== 0 ||
      saved.index.oid !== expected.oid ||
      saved.index.mode !== Number.parseInt(expected.mode, 8)
    ) {
      throw new CorruptError(`rebase index snapshot differs at ${saved.path}`);
    }
    const worktree = saved.worktree;
    if (worktree.kind !== "file" && worktree.kind !== "symlink") {
      throw new CorruptError(`rebase worktree snapshot differs at ${saved.path}`);
    }
    const mode =
      worktree.kind === "symlink" ? "120000" : (worktree.mode & 0o111) === 0 ? "100644" : "100755";
    if (worktree.oid !== expected.oid || mode !== expected.mode) {
      throw new CorruptError(`rebase worktree snapshot differs at ${saved.path}`);
    }
  }
}

function publishCompleted(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  exclusions: RebaseExclusions,
): RebaseLifecycleResult {
  return repo.store.db.transactionSync(() => {
    const journal = repo.checkout.requireOperationState("rebase");
    requireOriginalHead(repo, journal.state);
    if (journal.state.phase !== "running" || journal.state.currentStep !== journal.steps.length) {
      throw new CorruptError("rebase publication started before replay completion");
    }
    const tree = requireCurrentBaseline(repo, worktree, journal.state, exclusions);
    if (repo.readCommit(journal.state.currentParentOid).tree !== tree) {
      throw new CorruptError("completed rebase baseline changed before publication");
    }
    repo.mutateRefs(
      {
        expected: {
          name: journal.state.originalHeadRef,
          target: journal.state.originalHeadOid,
        },
        puts: [
          {
            name: journal.state.originalHeadRef,
            target: journal.state.currentParentOid,
          },
        ],
      },
      persistedRefLogMetadata(context, journal.state.committer, "rebase: replay"),
    );
    // False leaves the old baseline mismatched, so later sparse reads fall back safely.
    context.indexTracker?.advanceBaseline?.(repo.checkout.checkoutId, tree);
    repo.checkout.clearOperationState();
    return {
      outcome: "completed",
      oid: journal.state.currentParentOid,
      ...completedCounts(journal.steps),
      fastForward: false,
    };
  });
}

interface RebaseDriveState {
  integrityOid: string;
  phase: RebaseStateMetadata["phase"];
  currentStep: number;
  stepCount: number;
  replayed: number;
  skipped: number;
}

function readRebaseDriveState(repo: Repository): RebaseDriveState {
  const journal = repo.checkout.requireOperationState("rebase");
  requireOriginalHead(repo, journal.state);
  return {
    integrityOid: journal.integrityOid,
    phase: journal.state.phase,
    currentStep: journal.state.currentStep,
    stepCount: journal.steps.length,
    ...completedCounts(journal.steps),
  };
}

function driveRebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions,
  exclusions: RebaseExclusions,
): RebaseLifecycleResult {
  for (;;) {
    const state = readRebaseDriveState(repo);
    if (state.phase === "conflicted") {
      return { outcome: "conflicted", replayed: state.replayed, skipped: state.skipped };
    }
    if (state.currentStep === state.stepCount) {
      return publishCompleted(context, repo, worktree, exclusions);
    }
    applyOneStep(context, repo, worktree, state.integrityOid, options, exclusions);
  }
}

export function startRebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseStartOptions,
): RebaseLifecycleResult {
  const started = repo.store.db.transactionSync(() => {
    repo.checkout.requireNoOperationState();
    const head = requireHead(repo);
    const originalTree = repo.readCommit(head.oid).tree;
    requireRebaseIndex(repo);
    requireCleanIntegrationIndex(repo, originalTree, "rebase");
    requireCleanIntegrationWorktree(repo, worktree, "rebase");
    const plan = planRebase(repo, { upstream: options.upstream, currentOid: head.oid });
    if (plan.relation === "up-to-date") {
      return { relation: plan.relation, oid: head.oid };
    }
    const planReservation = repo.store.reserveMemory();
    planReservation.set("other", plan.retainedBytes);
    try {
      const replayOids = [plan.upstreamOid];
      for (const step of plan.steps) {
        replayOids.push(step.sourceOid);
        if (step.selectedParentOid !== null) replayOids.push(step.selectedParentOid);
      }
      if (plan.relation === "replay") preflightReplayCommitObjects(repo, replayOids);
      const upstreamTree = repo.readCommit(plan.upstreamOid).tree;
      const baseline = preflightBaselineTransition(repo, upstreamTree);
      if (plan.relation === "replay") preflightBaselineTransition(repo, originalTree);
      materializeTree(repo, worktree, originalTree, baseline);
      const observed = repo.head();
      if (observed.ref !== head.ref || observed.oid !== head.oid) {
        throw new GitError("ESTALEHEAD", "HEAD changed while rebase was being prepared");
      }
      if (plan.relation === "fast-forward") {
        repo.mutateRefs(
          {
            expected: { name: head.ref, target: head.oid },
            puts: [{ name: head.ref, target: plan.upstreamOid }],
          },
          operationRefLogMetadata(context, repo, "rebase: fast-forward", {
            identity: options.committer,
            env: options.env,
          }),
        );
        // False leaves the old baseline mismatched, so later sparse reads fall back safely.
        context.indexTracker?.advanceBaseline?.(repo.checkout.checkoutId, upstreamTree);
        return { relation: plan.relation, oid: plan.upstreamOid };
      }
      const actor = operationRefLogMetadata(context, repo, "rebase: replay", {
        identity: options.committer,
        env: options.env,
      }).actor;
      repo.checkout.writeOperationJournal(
        initialState(head, plan.upstreamOid, plan.baseOid, actor),
        plan.steps,
        [],
      );
      return { relation: plan.relation, oid: plan.upstreamOid };
    } finally {
      planReservation.dispose();
    }
  });
  if (started.relation === "up-to-date") return { outcome: "up-to-date", oid: started.oid };
  if (started.relation === "fast-forward") {
    return {
      outcome: "completed",
      oid: started.oid,
      replayed: 0,
      skipped: 0,
      fastForward: true,
    };
  }
  return driveRebase(context, repo, worktree, options, NO_REBASE_EXCLUSIONS);
}

type PreparedContinuation = { phase: "running" } | { phase: "conflicted"; integrityOid: string };

function prepareContinuation(
  repo: Repository,
  worktree: Worktree,
  exclusions: RebaseExclusions,
): PreparedContinuation {
  const journal = repo.checkout.requireOperationState("rebase");
  requireOriginalHead(repo, journal.state);
  requireResumedTopology(repo, journal);
  if (journal.state.phase === "running") {
    requireCurrentBaseline(repo, worktree, journal.state, exclusions);
    return { phase: "running" };
  }
  requireConflictOwnership(repo, worktree, journal);
  return { phase: "conflicted", integrityOid: journal.integrityOid };
}

export function continueRebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  return continueRebaseInternal(context, repo, worktree, options, NO_REBASE_EXCLUSIONS);
}

export function continueRebaseExcluding(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  return continueRebaseInternal(
    context,
    repo,
    worktree,
    options,
    rebaseExclusions(repo, excludeRoots),
  );
}

function continueRebaseInternal(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions,
  exclusions: RebaseExclusions,
): RebaseLifecycleResult {
  const prepared = prepareContinuation(repo, worktree, exclusions);
  if (prepared.phase === "running") {
    return driveRebase(context, repo, worktree, options, exclusions);
  }
  repo.store.db.transactionSync(() => {
    const current = repo.checkout.requireOperationState("rebase");
    if (current.integrityOid !== prepared.integrityOid) {
      throw new GitError("EOPMISMATCH", "rebase conflict changed before continuation");
    }
    requireOriginalHead(repo, current.state);
    if (repo.checkout.hasConflicts()) {
      throw new GitError("EUNMERGED", "cannot continue rebase: the index has unmerged paths");
    }
    requireRebaseIndex(repo);
    requireCleanIntegrationWorktree(repo, worktree, "rebase", exclusions.absolute);
    const journalReservation = repo.store.reserveMemory();
    journalReservation.set("other", current.retainedBytes);
    try {
      const retainedPlan = planCurrentStep(repo, current, current.retainedBytes);
      try {
        const plan = retainedPlan.plan;
        const planReservation = reserveIntegrationPlan(repo, plan.integration);
        try {
          const currentTree = repo.readCommit(current.state.currentParentOid).tree;
          const resultEmpty = integrationIndexMatchesTree(repo, currentTree);
          const baseline = resultEmpty ? preflightBaselineTransition(repo, currentTree) : null;
          if (resultEmpty) {
            if (baseline === null) throw new CorruptError("result-empty rebase lost its baseline");
            hardMaterializeTree(repo, worktree, currentTree, baseline, exclusions);
            advance(repo, current, "skipped", null);
          } else {
            const identities = stepIdentities(context, repo, plan, options);
            const result = writeUnpublishedCommit(repo, {
              message: plan.sourceCommit.message,
              parent: [current.state.currentParentOid],
              identities,
            });
            advance(repo, current, "applied", result.oid, identities.committer);
          }
        } finally {
          planReservation.dispose();
        }
      } finally {
        retainedPlan.release();
      }
    } finally {
      journalReservation.dispose();
    }
  });
  return driveRebase(context, repo, worktree, options, exclusions);
}

interface PreparedSkip {
  integrityOid: string;
  currentTree: string;
  baseline: BaselineTransition;
}

function prepareSkip(repo: Repository, worktree: Worktree): PreparedSkip {
  const journal = repo.checkout.requireOperationState("rebase");
  requireOriginalHead(repo, journal.state);
  requireResumedTopology(repo, journal);
  if (journal.state.phase !== "conflicted") {
    throw new GitError("EOPMISMATCH", "rebase skip requires a conflicted step");
  }
  requireConflictOwnership(repo, worktree, journal);
  const currentTree = repo.readCommit(journal.state.currentParentOid).tree;
  return {
    integrityOid: journal.integrityOid,
    currentTree,
    baseline: preflightBaselineTransition(repo, currentTree),
  };
}

export function skipRebase(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: RebaseContinueOptions = {},
): RebaseLifecycleResult {
  const prepared = prepareSkip(repo, worktree);
  repo.store.db.transactionSync(() => {
    const current = repo.checkout.requireOperationState("rebase");
    if (current.integrityOid !== prepared.integrityOid) {
      throw new GitError("EOPMISMATCH", "rebase conflict changed before skip");
    }
    requireOriginalHead(repo, current.state);
    hardMaterializeTree(
      repo,
      worktree,
      prepared.currentTree,
      prepared.baseline,
      NO_REBASE_EXCLUSIONS,
    );
    advance(repo, current, "skipped", null);
  });
  return driveRebase(context, repo, worktree, options, NO_REBASE_EXCLUSIONS);
}

interface PreparedAbort {
  integrityOid: string;
  baselineTree: string;
  baseline: BaselineTransition;
}

function prepareAbort(repo: Repository, worktree: Worktree): PreparedAbort {
  const journal = repo.checkout.requireOperationState("rebase");
  requireOriginalHead(repo, journal.state);
  requireResumedTopology(repo, journal);
  if (journal.state.phase === "conflicted") requireConflictOwnership(repo, worktree, journal);
  const originalTree = repo.readCommit(journal.state.originalHeadOid).tree;
  return {
    integrityOid: journal.integrityOid,
    baselineTree: repo.readCommit(journal.state.currentParentOid).tree,
    baseline: preflightBaselineTransition(repo, originalTree),
  };
}

export function abortRebase(repo: Repository, worktree: Worktree): void {
  abortRebaseInternal(repo, worktree, NO_REBASE_EXCLUSIONS);
}

export function abortRebaseExcluding(
  repo: Repository,
  worktree: Worktree,
  excludeRoots: readonly string[],
): void {
  abortRebaseInternal(repo, worktree, rebaseExclusions(repo, excludeRoots));
}

function abortRebaseInternal(
  repo: Repository,
  worktree: Worktree,
  exclusions: RebaseExclusions,
): void {
  const prepared = prepareAbort(repo, worktree);
  repo.store.db.transactionSync(() => {
    const current = repo.checkout.requireOperationState("rebase");
    if (current.integrityOid !== prepared.integrityOid) {
      throw new GitError("EOPMISMATCH", "rebase operation changed before abort");
    }
    requireOriginalHead(repo, current.state);
    hardMaterializeTree(repo, worktree, prepared.baselineTree, prepared.baseline, exclusions);
    repo.checkout.clearOperationState();
  });
}
