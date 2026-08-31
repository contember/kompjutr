// Bounded ancestry and best-common-ancestor selection over the indexed graph.

import { isOid } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import type { Commit } from "../common/objects.js";
import { MAX_LOG_COMMITS } from "../store/commits.js";
import { readShallowOwned } from "../store/index.js";
import { type Repository, walkIndexedOwned } from "./repository.js";

export const MAX_MERGE_BASE_COMMITS = MAX_LOG_COMMITS;
export const MAX_MERGE_BASES = 64;

const CURRENT = 1;
const INCOMING = 2;
const BOTH = CURRENT | INCOMING;

export type MergeBaseKind =
  | "already-merged"
  | "fast-forward"
  | "divergent"
  | "unrelated"
  | "shallow";

export interface MergeBaseSelection {
  kind: MergeBaseKind;
  /** Every best common ancestor, in deterministic OID order. */
  bases: readonly string[];
  /** Unique commits across both reachable graphs. */
  commits: number;
}

export interface MergeBaseLimits {
  maxCommits?: number;
  maxBases?: number;
}

export interface MergeBaseInput {
  currentOid: string;
  incomingOid: string;
  limits?: MergeBaseLimits;
}

export interface AheadBehindResult {
  ahead: number;
  behind: number;
  commits: number;
}

export interface DivergenceOptions {
  current: string;
  upstream: string;
}

export interface MergeBaseOptions {
  current: string;
  incoming: string;
}

export interface MergeBaseResult {
  kind: MergeBaseKind;
  bases: readonly string[];
}

export type DivergenceRelationship =
  | "identical"
  | "ahead"
  | "behind"
  | "diverged"
  | "unrelated"
  | "shallow";

export interface DivergenceResult {
  relationship: DivergenceRelationship;
  /** Commits reachable only from `current`. */
  ahead: number;
  /** Commits reachable only from `upstream`. */
  behind: number;
}

interface ResolvedLimits {
  maxCommits: number;
  maxBases: number;
}

interface GraphNode {
  commit: Commit;
  sides: number;
}

interface GraphState {
  readonly nodes: Map<string, GraphNode>;
  readonly shallow: ReadonlySet<string>;
}

function boundedLimit(value: number | undefined, ceiling: number, label: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(`invalid merge-base ${label} limit`);
  }
  return value;
}

function resolveLimits(limits: MergeBaseLimits | undefined): ResolvedLimits {
  return {
    maxCommits: boundedLimit(limits?.maxCommits, MAX_MERGE_BASE_COMMITS, "commit"),
    maxBases: boundedLimit(limits?.maxBases, MAX_MERGE_BASES, "base"),
  };
}

function sameParents(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function addReachable(
  repo: Repository,
  root: string,
  side: number,
  limits: ResolvedLimits,
  state: GraphState,
): void {
  for (const { oid, commit } of walkIndexedOwned(repo, root, {
    maxCommits: limits.maxCommits,
  })) {
    const existing = state.nodes.get(oid);
    if (existing !== undefined) {
      if (
        existing.commit.tree !== commit.tree ||
        !sameParents(existing.commit.parent, commit.parent)
      ) {
        throw new CorruptError("indexed graph returned inconsistent commit identities");
      }
      existing.sides |= side;
      continue;
    }
    if (state.nodes.size >= limits.maxCommits) {
      throw new GitError("E2BIG", `merge-base graph exceeds ${limits.maxCommits} unique commits`);
    }
    state.nodes.set(oid, { commit, sides: side });
  }
}

function compareOids(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function bestCommonAncestors(
  nodes: ReadonlyMap<string, GraphNode>,
  shallow: ReadonlySet<string>,
): string[] {
  const common = new Set<string>();
  const childCounts = new Map<string, number>();
  for (const [oid, node] of nodes) {
    childCounts.set(oid, 0);
    if (node.sides === BOTH) common.add(oid);
  }
  for (const [oid, node] of nodes) {
    for (const parent of node.commit.parent) {
      if (!nodes.has(parent)) {
        if (!shallow.has(oid)) throw new CorruptError("merge-base graph is missing a parent row");
        continue;
      }
      childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
    }
  }

  const ready: string[] = [];
  for (const [oid, children] of childCounts) {
    if (children === 0) ready.push(oid);
  }
  const hasCommonDescendant = new Set<string>();
  const dominated = new Set<string>();
  let processed = 0;
  while (ready.length > 0) {
    const oid = ready.pop()!;
    const node = nodes.get(oid);
    if (node === undefined) throw new CorruptError("merge-base graph lost a ready commit");
    processed++;
    const propagates = common.has(oid) || hasCommonDescendant.has(oid);
    for (const parent of node.commit.parent) {
      const children = childCounts.get(parent);
      if (children === undefined) continue;
      if (propagates) {
        hasCommonDescendant.add(parent);
        if (common.has(parent)) dominated.add(parent);
      }
      const remaining = children - 1;
      childCounts.set(parent, remaining);
      if (remaining === 0) ready.push(parent);
    }
  }
  if (processed !== nodes.size) throw new CorruptError("merge-base graph contains a cycle");
  return [...common].filter((oid) => !dominated.has(oid)).sort(compareOids);
}

function result(
  kind: MergeBaseKind,
  bases: readonly string[],
  state: GraphState,
): MergeBaseSelection {
  return {
    kind,
    bases,
    commits: state.nodes.size,
  };
}

function reachableGraphOwned(repo: Repository, input: MergeBaseInput): GraphState {
  if (!isOid(input.currentOid) || !isOid(input.incomingOid)) {
    throw new GitError("EINVAL", "merge-base inputs must be full object ids");
  }
  const limits = resolveLimits(input.limits);
  const currentType = repo.typeOf(input.currentOid);
  if (currentType !== "commit") {
    throw new CorruptError(`${input.currentOid} is a ${currentType}, not a commit`);
  }
  const incomingType = repo.typeOf(input.incomingOid);
  if (incomingType !== "commit") {
    throw new CorruptError(`${input.incomingOid} is a ${incomingType}, not a commit`);
  }
  const state: GraphState = {
    nodes: new Map(),
    shallow: readShallowOwned(repo.store),
  };
  addReachable(repo, input.currentOid, CURRENT, limits, state);
  addReachable(repo, input.incomingOid, INCOMING, limits, state);
  return state;
}

function withReachableGraph<T>(
  repo: Repository,
  input: MergeBaseInput,
  body: (state: GraphState, limits: ResolvedLimits) => T,
): T {
  return body(reachableGraphOwned(repo, input), resolveLimits(input.limits));
}

/** Count commits reachable from only one side of two bounded indexed histories. */
export function countAheadBehind(repo: Repository, input: MergeBaseInput): AheadBehindResult {
  return withReachableGraph(repo, input, (state) => {
    let ahead = 0;
    let behind = 0;
    for (const node of state.nodes.values()) {
      if (node.sides === CURRENT) ahead++;
      else if (node.sides === INCOMING) behind++;
    }
    return {
      ahead,
      behind,
      commits: state.nodes.size,
    };
  });
}

/** Compare two caller-selected revisions through one bounded reachable graph. */
export function divergence(repo: Repository, options: DivergenceOptions): DivergenceResult {
  const currentOid = repo.peel(repo.revParse(options.current));
  const upstreamOid = repo.peel(repo.revParse(options.upstream));
  return withReachableGraph(repo, { currentOid, incomingOid: upstreamOid }, (state) => {
    let ahead = 0;
    let behind = 0;
    let related = false;
    for (const node of state.nodes.values()) {
      if (node.sides === CURRENT) ahead++;
      else if (node.sides === INCOMING) behind++;
      else related = true;
    }

    for (const oid of state.shallow) {
      const node = state.nodes.get(oid);
      if (node !== undefined && node.sides !== BOTH) {
        return { relationship: "shallow", ahead, behind };
      }
    }
    if (!related) return { relationship: "unrelated", ahead, behind };
    if (ahead === 0 && behind === 0) return { relationship: "identical", ahead, behind };
    if (behind === 0) return { relationship: "ahead", ahead, behind };
    if (ahead === 0) return { relationship: "behind", ahead, behind };
    return { relationship: "diverged", ahead, behind };
  });
}

/** Resolve two revisions and return their bounded best-common-ancestor classification. */
export function mergeBase(repo: Repository, options: MergeBaseOptions): MergeBaseResult {
  const currentOid = repo.peel(repo.revParse(options.current));
  const incomingOid = repo.peel(repo.revParse(options.incoming));
  const { kind, bases } = selectMergeBases(repo, { currentOid, incomingOid });
  return { kind, bases };
}

/** Select ancestry mode and all best common ancestors without mutating repository state. */
export function selectMergeBases(repo: Repository, input: MergeBaseInput): MergeBaseSelection {
  return withReachableGraph(repo, input, (state, limits) => {
    if (state.nodes.get(input.incomingOid)?.sides === BOTH) {
      return result("already-merged", [input.incomingOid], state);
    }
    if (state.nodes.get(input.currentOid)?.sides === BOTH) {
      return result("fast-forward", [input.currentOid], state);
    }

    for (const oid of state.shallow) {
      const node = state.nodes.get(oid);
      if (node !== undefined && node.sides !== BOTH) return result("shallow", [], state);
    }
    const bases = bestCommonAncestors(state.nodes, state.shallow);
    if (bases.length === 0) return result("unrelated", [], state);
    if (bases.length > limits.maxBases) {
      throw new GitError("E2BIG", `merge-base result exceeds ${limits.maxBases} best bases`);
    }
    return result("divergent", bases, state);
  });
}
