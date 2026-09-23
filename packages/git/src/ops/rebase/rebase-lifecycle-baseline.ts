import { CorruptError, GitError } from "../../common/errors.js";
import { relativeTo } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import {
  type IndexEntry,
  type RebaseJournalCursor,
  readRebaseCursorOwned,
} from "../../store/index.js";
import { advanceRebaseOwned } from "../../store/operations/operation-journal.js";
import { checkoutTreeExcluding } from "../checkout/checkout.js";
import type { GitIdentity } from "../core/context.js";
import { operationNotActive, type RebaseStateMetadata } from "../core/operation-state.js";
import {
  integrationIndexMatchesTree,
  requireBoundedIntegrationIndex,
  requireBoundedIntegrationTree,
  requireCleanIntegrationWorktree,
} from "../integration/integration-worktree.js";
import { checkoutBlockers } from "../refs/refs.js";
import { describeBlockers } from "../refs/refs-checkout-guard.js";
import { preflightReplayCommitObjects } from "../replay/replay-revision.js";
import type { Repository } from "../repository/repository.js";
import { treeStream } from "../tree/tree-stream.js";
import type { Worktree } from "../worktree/worktree.js";
import type { RebaseExclusions } from "./rebase-lifecycle-types.js";
import type { RebasePlan } from "./rebase-plan.js";

const BASELINE_OBJECT_PAGE = 1_000;
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

export function requireCurrentBaseline(
  repo: Repository,
  worktree: Worktree,
  state: RebaseStateMetadata,
  exclusions: RebaseExclusions,
): string {
  const tree = repo.readCommit(state.currentParentOid).tree;
  requireBoundedIntegrationIndex(repo);
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
  targetTree: string,
  exclusions: RebaseExclusions,
): void {
  const blockers = checkoutBlockers(repo, worktree, {
    baselineTree,
    tree: targetTree,
    prune: true,
    excludeRoots: exclusions.absolute,
    mode: "checkout",
  });
  if (blockers.tracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `local changes to ${describeBlockers(blockers.tracked, blockers.trackedOmitted)} would be overwritten by rebase`,
    );
  }
  if (blockers.untracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `untracked working tree files would be overwritten by rebase: ${describeBlockers(blockers.untracked, blockers.untrackedOmitted)}`,
    );
  }
  checkoutTreeExcluding(repo, worktree, targetTree, exclusions.absolute, {
    preserveMatchingIndex: true,
  });
}

export function hardMaterializeTree(
  repo: Repository,
  worktree: Worktree,
  baselineTree: string,
  targetTree: string,
  exclusions: RebaseExclusions,
): void {
  const blockers = checkoutBlockers(repo, worktree, {
    baselineTree,
    tree: targetTree,
    prune: true,
    excludeRoots: exclusions.absolute,
    mode: "hard-reset",
  });
  if (blockers.untracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `untracked working tree files would be overwritten by rebase: ${describeBlockers(blockers.untracked, blockers.untrackedOmitted)}`,
    );
  }
  checkoutTreeExcluding(repo, worktree, targetTree, exclusions.absolute, {
    preserveMatchingIndex: false,
    restoreStructure: true,
    discardUnmerged: true,
  });
}

/**
 * One pass over the tree refuses gitlinks, measures each tree object, and
 * checks blob types a page at a time, so memory is independent of tree size.
 */
export function preflightBaselineTree(repo: Repository, treeOid: string): void {
  let page = new Set<string>();
  const flush = (): void => {
    const oids = [...page];
    page = new Set<string>();
    const types = new Map<string, string>();
    for (const object of repo.store.objectInfo(oids)) types.set(object.oid, object.type);
    for (const oid of oids) {
      const type = types.get(oid);
      if (type === undefined) {
        throw new CorruptError(`rebase baseline object ${oid} is missing`);
      }
      if (type !== "blob") throw new CorruptError(`rebase baseline object ${oid} is not a blob`);
    }
  };
  const entries = function* (): Generator<IndexEntry> {
    for (const entry of treeStream(repo, treeOid)) {
      if (entry.mode === "160000") {
        throw new GitError("EUNSUPPORTED", `rebase cannot materialize gitlink ${entry.path}`);
      }
      page.add(entry.oid);
      if (page.size >= BASELINE_OBJECT_PAGE) flush();
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
    flush();
  };
  requireBoundedIntegrationTree(repo, entries());
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
