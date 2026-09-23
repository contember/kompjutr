// Pure selection of one bounded linear rebase sequence.

import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { MAX_OPERATION_STEPS, type OperationStepMetadata } from "../core/operation-state.js";
import {
  MAX_MERGE_BASE_COMMITS,
  type MergeBaseLimits,
  type MergeBaseSelection,
  selectMergeBases,
} from "../merge/merge-base.js";
import { resolveBoundedCommitRevision } from "../replay/replay-revision.js";
import { type Repository, walkIndexedOwned } from "../repository/repository.js";

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

function selectSteps(
  repo: Repository,
  currentOid: string,
  baseOid: string,
  limits: ResolvedLimits,
): readonly OperationStepMetadata[] {
  const newestFirst: OperationStepMetadata[] = [];
  let oid = currentOid;
  let foundBase = false;
  for (const entry of walkIndexedOwned(repo, currentOid, limits.graph)) {
    if (entry.oid !== oid) {
      throw new CorruptError("rebase linear walk diverged from the selected parent chain");
    }
    if (entry.oid === baseOid) {
      foundBase = true;
      break;
    }
    if (newestFirst.length >= limits.maxSteps) {
      throw new GitError("E2BIG", `rebase plan exceeds ${limits.maxSteps} steps`);
    }
    if (entry.commit.parent.length !== 1) {
      throw new GitError("EUNSUPPORTED", "rebase selected range is not linear");
    }
    const selectedParentOid = entry.commit.parent[0];
    if (selectedParentOid === undefined) {
      throw new CorruptError(`rebase commit ${oid} lost its selected parent`);
    }
    const step: OperationStepMetadata = {
      sourceOid: oid,
      selectedParentOid,
      mainline: null,
      outcome: "pending",
      resultOid: null,
    };
    newestFirst.push(step);
    oid = selectedParentOid;
  }
  if (!foundBase) throw new CorruptError("rebase linear walk did not reach the selected base");
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
  const selection = selectMergeBases(repo, {
    currentOid: input.currentOid,
    incomingOid: upstreamOid,
    limits: limits.graph,
  });
  const baseOid = requireUniqueBase(selection);
  if (selection.kind === "already-merged") {
    return zeroStepPlan("up-to-date", input.currentOid, upstreamOid, baseOid, selection);
  }
  if (selection.kind === "fast-forward") {
    return zeroStepPlan("fast-forward", input.currentOid, upstreamOid, baseOid, selection);
  }
  const steps = selectSteps(repo, input.currentOid, baseOid, limits);
  return {
    relation: "replay",
    originalHeadOid: input.currentOid,
    upstreamOid,
    baseOid,
    steps,
    graphCommits: selection.commits,
  };
}
