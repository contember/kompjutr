// Bounded ancestry and best-common-ancestor selection over the indexed graph.

import { commitCacheBytes, MAX_LOG_COMMITS, MAX_LOG_STATE_BYTES } from "../../sqlite/commits.js";
import { isOid } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import type { Commit } from "../objects.js";
import type { Repository } from "../repository.js";

export const MAX_MERGE_BASE_COMMITS = MAX_LOG_COMMITS;
export const MAX_MERGE_BASE_RETAINED_BYTES = MAX_LOG_STATE_BYTES;
export const MAX_MERGE_BASES = 64;
/** Two commit-type checks, two indexed root checks, two graph cursors, and one shallow read. */
export const MERGE_BASE_SQL_STATEMENTS = 7;
/** Ahead/behind uses the same validated roots and indexed graph cursors as merge-base. */
export const AHEAD_BEHIND_SQL_STATEMENTS = 7;

const CURRENT = 1;
const INCOMING = 2;
const BOTH = CURRENT | INCOMING;
const GRAPH_NODE_BYTES = 256;
const GRAPH_PARENT_EDGE_BYTES = 32;

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
  /** Unique commits retained across both reachable graphs. */
  commits: number;
  retainedBytes: number;
  sqlStatements: number;
}

export interface MergeBaseLimits {
  maxCommits?: number;
  maxRetainedBytes?: number;
  maxBases?: number;
  maxSqlStatements?: number;
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
  retainedBytes: number;
  sqlStatements: number;
}

export interface DivergenceOptions {
  current: string;
  upstream: string;
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
  maxRetainedBytes: number;
  maxBases: number;
  maxSqlStatements: number;
}

interface GraphNode {
  commit: Commit;
  sides: number;
}

interface GraphState {
  readonly nodes: Map<string, GraphNode>;
  retainedBytes: number;
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
    maxRetainedBytes: boundedLimit(
      limits?.maxRetainedBytes,
      MAX_MERGE_BASE_RETAINED_BYTES,
      "retained byte",
    ),
    maxBases: boundedLimit(limits?.maxBases, MAX_MERGE_BASES, "base"),
    maxSqlStatements: boundedLimit(
      limits?.maxSqlStatements,
      MERGE_BASE_SQL_STATEMENTS,
      "SQL statement",
    ),
  };
}

function retainedNodeBytes(commit: Commit): number {
  const edges = commit.parent.length * GRAPH_PARENT_EDGE_BYTES;
  const retained = commitCacheBytes(commit) + GRAPH_NODE_BYTES + edges;
  if (!Number.isSafeInteger(retained)) {
    throw new GitError("E2BIG", "merge-base retained-state accounting overflow");
  }
  return retained;
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
  for (const { oid, commit } of repo.walkIndexed(root, {
    maxCommits: limits.maxCommits,
    maxBytes: limits.maxRetainedBytes,
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
    const bytes = retainedNodeBytes(commit);
    if (bytes > limits.maxRetainedBytes - state.retainedBytes) {
      throw new GitError(
        "E2BIG",
        `merge-base graph exceeds ${limits.maxRetainedBytes} retained bytes`,
      );
    }
    state.retainedBytes += bytes;
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
    retainedBytes: state.retainedBytes,
    sqlStatements: MERGE_BASE_SQL_STATEMENTS,
  };
}

function reachableGraph(
  repo: Repository,
  input: MergeBaseInput,
  requiredSqlStatements: number,
): GraphState {
  if (!isOid(input.currentOid) || !isOid(input.incomingOid)) {
    throw new GitError("EINVAL", "merge-base inputs must be full object ids");
  }
  const limits = resolveLimits(input.limits);
  if (limits.maxSqlStatements < requiredSqlStatements) {
    throw new GitError("E2BIG", `merge-base requires ${requiredSqlStatements} SQL statements`);
  }
  const currentType = repo.typeOf(input.currentOid);
  if (currentType !== "commit") {
    throw new CorruptError(`${input.currentOid} is a ${currentType}, not a commit`);
  }
  const incomingType = repo.typeOf(input.incomingOid);
  if (incomingType !== "commit") {
    throw new CorruptError(`${input.incomingOid} is a ${incomingType}, not a commit`);
  }
  const state: GraphState = { nodes: new Map(), retainedBytes: 0 };
  addReachable(repo, input.currentOid, CURRENT, limits, state);
  addReachable(repo, input.incomingOid, INCOMING, limits, state);
  return state;
}

/** Count commits reachable from only one side of two bounded indexed histories. */
export function countAheadBehind(repo: Repository, input: MergeBaseInput): AheadBehindResult {
  const state = reachableGraph(repo, input, AHEAD_BEHIND_SQL_STATEMENTS);
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
    retainedBytes: state.retainedBytes,
    sqlStatements: AHEAD_BEHIND_SQL_STATEMENTS,
  };
}

/** Compare two caller-selected revisions through one bounded reachable graph. */
export function divergence(repo: Repository, options: DivergenceOptions): DivergenceResult {
  const currentOid = repo.peel(repo.revParse(options.current));
  const upstreamOid = repo.peel(repo.revParse(options.upstream));
  const state = reachableGraph(
    repo,
    { currentOid, incomingOid: upstreamOid },
    AHEAD_BEHIND_SQL_STATEMENTS,
  );

  let ahead = 0;
  let behind = 0;
  let related = false;
  for (const node of state.nodes.values()) {
    if (node.sides === CURRENT) ahead++;
    else if (node.sides === INCOMING) behind++;
    else related = true;
  }

  for (const oid of repo.shallow()) {
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
}

/** Select ancestry mode and all best common ancestors without mutating repository state. */
export function selectMergeBases(repo: Repository, input: MergeBaseInput): MergeBaseSelection {
  const limits = resolveLimits(input.limits);
  const state = reachableGraph(repo, input, MERGE_BASE_SQL_STATEMENTS);

  if (state.nodes.get(input.incomingOid)?.sides === BOTH) {
    return result("already-merged", [input.incomingOid], state);
  }
  if (state.nodes.get(input.currentOid)?.sides === BOTH) {
    return result("fast-forward", [input.currentOid], state);
  }

  const shallow = repo.shallow();
  for (const oid of shallow) {
    const node = state.nodes.get(oid);
    if (node !== undefined && node.sides !== BOTH) return result("shallow", [], state);
  }
  const bases = bestCommonAncestors(state.nodes, shallow);
  if (bases.length === 0) return result("unrelated", [], state);
  if (bases.length > limits.maxBases) {
    throw new GitError("E2BIG", `merge-base result exceeds ${limits.maxBases} best bases`);
  }
  return result("divergent", bases, state);
}
