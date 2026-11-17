// Pure selection of one bounded linear rebase sequence; merges whose other
// parents the upstream already holds are dropped, as git does without -r.

import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import type { Commit } from "../../common/objects.js";
import { MAX_OPERATION_STEPS, type OperationStepMetadata } from "../core/operation-state.js";
import {
  MAX_MERGE_BASE_COMMITS,
  type MergeBaseGraph,
  type MergeBaseLimits,
  type MergeBaseSelection,
  selectMergeBaseGraph,
} from "../merge/merge-base.js";
import { resolveBoundedCommitRevision } from "../replay/replay-revision.js";
import type { Repository } from "../repository/repository.js";

export type RebasePlanRelation = "up-to-date" | "fast-forward" | "replay";

export interface RebasePlanInput {
  upstream: string;
  currentOid: string;
  limits?: RebasePlanLimits;
}

export interface RebasePlanLimits {
  maxSteps?: number;
  maxGraphCommits?: number;
}

export interface RebasePlan {
  relation: RebasePlanRelation;
  originalHeadOid: string;
  upstreamOid: string;
  baseOid: string;
  steps: readonly OperationStepMetadata[];
  graphCommits: number;
}

interface ResolvedLimits {
  maxSteps: number;
  graph: MergeBaseLimits;
}

function boundedLimit(value: number | undefined, ceiling: number, label: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(`invalid rebase ${label} limit`);
  }
  return value;
}

function resolveLimits(limits: RebasePlanLimits | undefined): ResolvedLimits {
  return {
    maxSteps: boundedLimit(limits?.maxSteps, MAX_OPERATION_STEPS, "step"),
    graph: {
      maxCommits: boundedLimit(limits?.maxGraphCommits, MAX_MERGE_BASE_COMMITS, "graph commit"),
    },
  };
}

function zeroStepPlan(
  relation: Exclude<RebasePlanRelation, "replay">,
  currentOid: string,
  upstreamOid: string,
  baseOid: string,
  selection: MergeBaseSelection,
): RebasePlan {
  return {
    relation,
    originalHeadOid: currentOid,
    upstreamOid,
    baseOid,
    steps: [],
    graphCommits: selection.commits,
  };
}

function requireUniqueBase(selection: MergeBaseSelection): string {
  if (selection.kind === "shallow") {
    throw new GitError("ESHALLOW", "cannot determine rebase base across a shallow boundary");
  }
  if (selection.kind === "unrelated") {
    throw new GitError("EUNRELATED", "refusing to rebase unrelated histories");
  }
  if (selection.bases.length !== 1) {
    throw new GitError("EUNSUPPORTED", "rebase requires one unique merge base");
  }
  const base = selection.bases[0];
  if (base === undefined) throw new CorruptError("rebase merge-base selection is empty");
  return base;
}

interface RangeCommit {
  oid: string;
  commit: Commit;
  parentOid: string;
}

/**
 * HEAD's first-parent chain down to the first commit the upstream reaches.
 * While every merge on it takes its other parents from the upstream, this is
 * exactly git's `upstream..HEAD`, so the replay order needs no topo sort.
 */
function* firstParentRange(graph: MergeBaseGraph, currentOid: string): Generator<RangeCommit> {
  let oid = currentOid;
  while (!graph.incomingReaches(oid)) {
    const commit = graph.commit(oid);
    if (commit === undefined) {
      throw new GitError("ESHALLOW", "cannot determine rebase range across a shallow boundary");
    }
    const parentOid = commit.parent[0];
    if (parentOid === undefined) {
      throw new GitError("EUNSUPPORTED", "rebase selected range contains a root commit");
    }
    yield { oid, commit, parentOid };
    oid = parentOid;
  }
}

/** git's `is_linear_history`: no merge between HEAD and an upstream it contains. */
function isLinearRange(graph: MergeBaseGraph, currentOid: string): boolean {
  for (const { commit } of firstParentRange(graph, currentOid)) {
    if (commit.parent.length > 1) return false;
  }
  return true;
}

function selectSteps(
  graph: MergeBaseGraph,
  currentOid: string,
  limits: ResolvedLimits,
): readonly OperationStepMetadata[] {
  const newestFirst: OperationStepMetadata[] = [];
  for (const { oid, commit, parentOid: selectedParentOid } of firstParentRange(graph, currentOid)) {
    const merged = commit.parent.slice(1);
    if (merged.length > 0) {
      // git drops the merge itself; commits it brings in beside the upstream
      // would be replayed in git's topological order, which is not modelled.
      for (const parentOid of merged) {
        if (!graph.incomingReaches(parentOid)) {
          throw new GitError("EUNSUPPORTED", "rebase selected range merges unreplayable commits");
        }
      }
      continue;
    }
    if (newestFirst.length >= limits.maxSteps) {
      throw new GitError("E2BIG", `rebase plan exceeds ${limits.maxSteps} steps`);
    }
    newestFirst.push({
      sourceOid: oid,
      selectedParentOid,
      mainline: null,
      outcome: "pending",
      resultOid: null,
    });
  }
  newestFirst.reverse();
  return newestFirst;
}

/** Resolve an upstream and select the commits a non-interactive rebase would replay. */
export function planRebase(repo: Repository, input: RebasePlanInput): RebasePlan {
  const limits = resolveLimits(input.limits);
  if (!isOid(input.currentOid)) {
    throw new GitError("EINVAL", "rebase current commit must be a full object id");
  }
  const upstreamOid = resolveBoundedCommitRevision(repo, input.upstream, {
    input: "rebase upstream",
    operation: "rebase",
  });
  const { selection, graph } = selectMergeBaseGraph(repo, {
    currentOid: input.currentOid,
    incomingOid: upstreamOid,
    limits: limits.graph,
  });
  const baseOid = requireUniqueBase(selection);
  // As git's can_fast_forward: a merge above a contained upstream still replays.
  if (selection.kind === "already-merged" && isLinearRange(graph, input.currentOid)) {
    return zeroStepPlan("up-to-date", input.currentOid, upstreamOid, baseOid, selection);
  }
  if (selection.kind === "fast-forward") {
    return zeroStepPlan("fast-forward", input.currentOid, upstreamOid, baseOid, selection);
  }
  const steps = selectSteps(graph, input.currentOid, limits);
  return {
    relation: "replay",
    originalHeadOid: input.currentOid,
    upstreamOid,
    baseOid,
    steps,
    graphCommits: selection.commits,
  };
}
