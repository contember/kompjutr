import { CorruptError, GitError } from "../common/errors.js";
import { relativeTo } from "../common/paths.js";
import { comparePaths } from "../common/streams.js";
import {
  type IndexEntry,
  type RebaseJournalCursor,
  readRebaseCursorOwned,
} from "../store/index.js";
import { advanceRebaseOwned } from "../store/operation-journal.js";
import { checkoutTreeExcluding } from "./checkout.js";
import type { GitIdentity } from "./context.js";
import {
  integrationIndexMatchesTree,
  requireBoundedIntegrationIndex,
  requireBoundedIntegrationTree,
  requireCleanIntegrationWorktree,
} from "./integration-worktree.js";
import {
  type OperationStepMetadata,
  operationNotActive,
  type RebaseStateMetadata,
} from "./operation-state.js";
import type { BaselineTransition, RebaseExclusions } from "./rebase-lifecycle-types.js";
import type { RebasePlan } from "./rebase-plan.js";
import type { CheckoutBlockerLimits } from "./refs.js";
import { checkoutBlockersAgainstOwned, hardResetBlockersAgainstOwned } from "./refs.js";
import { preflightReplayCommitObjects } from "./replay.js";
import type { Repository } from "./repository.js";
import { treeStream } from "./tree-stream.js";
import type { Worktree } from "./worktree.js";

const REBASE_BASELINE_MAX_ENTRIES = 4_096;
const REBASE_EXCLUDE_ROOTS = 64;
export function preflightRebaseReplayObjects(repo: Repository, plan: RebasePlan): void {
  if (plan.relation !== "replay") return;
  const replayOids = [plan.upstreamOid];
  for (const step of plan.steps) {
    replayOids.push(step.sourceOid);
    if (step.selectedParentOid !== null) replayOids.push(step.selectedParentOid);
  }
  preflightReplayCommitObjects(repo, replayOids);
}
export function requireRebaseCursor(repo: Repository): RebaseJournalCursor {
  const journal = readRebaseCursorOwned(repo.checkout);
  if (journal === null) throw operationNotActive("rebase");
  return journal;
}

export function rebaseExclusions(repo: Repository, roots: readonly string[]): RebaseExclusions {
  if (roots.length > REBASE_EXCLUDE_ROOTS) {
    throw new GitError("E2BIG", `rebase exclusions exceed ${REBASE_EXCLUDE_ROOTS} roots`);
  }
  const absolute: string[] = [];
  const relative: string[] = [];
  for (const root of roots) {
    const path = relativeTo(repo.root, root);
    if (path === null || path === "") {
      throw new GitError("EINVAL", `rebase exclusion ${root} is not nested under ${repo.root}`);
    }
    if (relative.includes(path)) {
      continue;
    }
    absolute.push(root);
    relative.push(path);
  }
  absolute.sort(comparePaths);
  relative.sort(comparePaths);
  return { absolute, relative };
}

export function requirePathsOutsideExclusions(
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

export function requireRebaseIndex(repo: Repository) {
  const stats = requireBoundedIntegrationIndex(repo);
  if (stats.leafEntries > REBASE_BASELINE_MAX_ENTRIES) {
    throw new GitError("E2BIG", `rebase index exceeds ${REBASE_BASELINE_MAX_ENTRIES} entries`);
  }
  return stats;
}

export function requireRebaseTree(
  repo: Repository,
  entries: Parameters<typeof requireBoundedIntegrationTree>[1],
) {
  const stats = requireBoundedIntegrationTree(repo, entries);
  if (stats.leafEntries > REBASE_BASELINE_MAX_ENTRIES) {
    throw new GitError("E2BIG", `rebase result exceeds ${REBASE_BASELINE_MAX_ENTRIES} entries`);
  }
  return stats;
}

export function requireHead(repo: Repository): { ref: string; oid: string } {
  const head = repo.head();
  if (head.ref === null) throw new GitError("EDETACHED", "cannot rebase with a detached HEAD");
  if (!head.ref.startsWith("refs/heads/")) {
    throw new GitError("EWRONGHEAD", "cannot rebase: HEAD is not a checked-out local branch");
  }
  if (head.oid === null) throw new GitError("ENOCOMMIT", "cannot rebase an unborn branch");
  return { ref: head.ref, oid: head.oid };
}

export function requireOriginalHead(repo: Repository, state: RebaseStateMetadata): void {
  const head = repo.head();
  if (head.ref !== state.originalHeadRef || head.oid !== state.originalHeadOid) {
    throw new GitError("ESTALEHEAD", "HEAD changed during the rebase operation");
  }
}

export function sameQueueStep(left: OperationStepMetadata, right: OperationStepMetadata): boolean {
  return (
    left.sourceOid === right.sourceOid &&
    left.selectedParentOid === right.selectedParentOid &&
    left.mainline === right.mainline
  );
}

export function requireCurrentBaseline(
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

export function materializeTree(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string,
  target: BaselineTransition,
  exclusions: RebaseExclusions,
): void {
  const blockers = checkoutBlockersAgainstOwned(
    repo,
    worktree,
    baselineTree,
    target.treeOid,
    undefined,
    true,
    checkoutGuardLimits(),
    exclusions.absolute,
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
  checkoutTreeExcluding(repo, worktree, target.treeOid, exclusions.absolute, {
    preserveMatchingIndex: true,
    maxWorktreeRowsPerPass: 50_000,
  });
}

function checkoutGuardLimits(): CheckoutBlockerLimits {
  return {
    maxRows: 50_000,
    rows: 0,
    maxHashCandidates: REBASE_BASELINE_MAX_ENTRIES,
    hashCandidates: 0,
  };
}

export function hardMaterializeTree(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string,
  target: BaselineTransition,
  exclusions: RebaseExclusions,
): void {
  const blockers = hardResetBlockersAgainstOwned(
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

export function preflightBaselineTransition(repo: Repository, treeOid: string): BaselineTransition {
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
  const unique = [...new Set(oids)];
  const info = repo.store.objectInfo(unique);
  if (info.length !== unique.length) {
    throw new CorruptError("rebase baseline object metadata is incomplete");
  }
  for (let ordinal = 0; ordinal < info.length; ordinal++) {
    const object = info[ordinal];
    const oid = unique[ordinal];
    if (object === undefined || oid === undefined || object.oid !== oid) {
      throw new CorruptError("rebase baseline object metadata is out of order");
    }
    if (object.type !== "blob") {
      throw new CorruptError(`rebase baseline object ${object.oid} is not a blob`);
    }
  }
  return { treeOid };
}

export function initialState(
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

export function advance(
  repo: Repository,
  journal: RebaseJournalCursor,
  outcome: "applied" | "skipped",
  resultOid: string | null,
  committer?: GitIdentity,
): void {
  advanceRebaseOwned(
    repo.checkout,
    journal.state.phase,
    journal.state.currentStep,
    outcome,
    resultOid,
    resultOid ?? journal.state.currentParentOid,
    committer ?? journal.state.committer,
  );
}
