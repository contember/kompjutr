// Two-head merge orchestration over bounded graph, integration, and apply seams.

import type { IndexEntry, ObjectBatch } from "../../sqlite/store.js";
import type { GitContext, GitIdentity } from "../context.js";
import { GitError } from "../errors.js";
import { hashObject, type ObjectType, serializeCommit } from "../objects.js";
import type { Repository, ResolvedHead } from "../repository.js";
import { comparePaths, joinSorted } from "../streams.js";
import type { Worktree } from "../worktree.js";
import { type CommitIdentities, commitIndex, resolveIdentity } from "./commit.js";
import {
  type IntegrationPlan,
  MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ,
  MAX_INTEGRATION_TREE_STATEMENTS,
  MAX_VIRTUAL_ANCESTOR_TREE_STATEMENTS,
  planIntegration,
  planVirtualAncestorIntegration,
} from "./integration.js";
import type { MergeResult } from "./kinds.js";
import { abortProjectedMerge, applyProjectedMerge } from "./merge-apply.js";
import { selectMergeBases } from "./merge-base.js";
import { type ProjectedMergeEntry, projectMergePlan } from "./merge-projection.js";
import {
  MAX_MERGE_IDENTITY_BYTES,
  MAX_MERGE_MESSAGE_BYTES,
  type MergeJournal,
  type MergeStateMetadata,
  type MergeTouchedPath,
  validateMergeStateMetadata,
} from "./merge-state.js";
import { checkoutBlockers } from "./refs.js";
import {
  buildTreeInBatch,
  preflightTreeBuild,
  type TreeBuildPreflightStats,
} from "./tree-build.js";
import { treeStream } from "./tree-stream.js";
import { walkWorktreeEntriesStream } from "./worktree-io.js";

const HEADS = "refs/heads/";
const MAX_MERGE_REVISION_CODE_UNITS = 1_024;
const MAX_RELOCATION_COLLISIONS = 1_000;
const MAX_VIRTUAL_COMMITS = 1;
const MAX_MERGE_REPOSITORY_ROWS = 50_000;
const MAX_MERGE_INDEX_ENTRIES = 10_000;
const MAX_MERGE_INDEX_PATH_BYTES = 4 * 1024 * 1024;
const MAX_MERGE_TREE_OBJECTS = 4_096;
const MAX_MERGE_SERIALIZED_TREE_BYTES = 16 * 1024 * 1024;
const MAX_MERGE_GUARD_HASH_BYTES = 32 * 1024 * 1024;
// One 16 MiB tree plus one 8 MiB blob/filesystem batch beside the retained plan.
const MERGE_EXECUTION_HEADROOM_BYTES = 24 * 1024 * 1024;
const MERGE_FIXED_SQL_STATEMENTS = 30;
const MERGE_INDEX_SQL_STATEMENTS = 48;
const MERGE_GUARD_SQL_STATEMENTS = 300;
const MERGE_COLLISION_SQL_STATEMENTS = 160;
const MERGE_OBJECT_BATCH_BYTES = 1024 * 1024;
const MERGE_OBJECT_BATCH_COUNT = 4_096;
const MERGE_TREE_INDEX_ROWS = 2_048;
const VIRTUAL_OBJECT_PAYLOAD_BYTES = 1024 * 1024;
const VIRTUAL_OBJECT_OVERHEAD_BYTES = 64 * 1024;
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

export interface MergeBehavior {
  /** Compatibility clients cannot reach native continue/abort after a conflict. */
  persistConflicts?: boolean;
  /** Pull supplies the remote branch label without changing revision lookup. */
  incomingLabel?: string;
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

interface VirtualBudget {
  commits: number;
  sqlStatements: number;
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

function virtualMaterializationStatements(
  repo: Repository,
  currentOid: string,
  incomingOid: string,
  plan: IntegrationPlan,
): number {
  const currentTree = commitTree(repo, currentOid);
  requireBoundedTreeEntries(virtualTreeEntries(repo, batchForIdentity(), currentTree, plan));
  let statements = 1;
  const batch: ObjectBatch = {
    write(type: ObjectType, data: Uint8Array): string {
      const payloads = Math.max(
        1,
        Math.ceil((data.length + VIRTUAL_OBJECT_OVERHEAD_BYTES) / VIRTUAL_OBJECT_PAYLOAD_BYTES),
      );
      statements += 2 + payloads;
      if (type === "tree") statements += 2;
      if (type === "commit") statements++;
      return hashObject(type, data);
    },
    flush() {},
  };
  const tree = buildTreeInBatch(batch, virtualTreeEntries(repo, batch, currentTree, plan));
  batch.write(
    "commit",
    serializeCommit({
      tree,
      parent: [currentOid, incomingOid],
      author: VIRTUAL_IDENTITY,
      committer: VIRTUAL_IDENTITY,
      message: "virtual merge base\n",
    }),
  );
  return statements;
}

function batchForIdentity(): ObjectBatch {
  return {
    write: (type, data) => hashObject(type, data),
    flush() {},
  };
}

function integrationSqlStatements(plan: IntegrationPlan, treeStatements: number): number {
  return treeStatements + plan.blobReadCalls * MAX_INTEGRATION_STATEMENTS_PER_BLOB_READ;
}

function commitSqlStatements(stats: TreeBuildPreflightStats): number {
  const objects = stats.treeObjects + 1;
  const payloadBytes =
    stats.serializedTreeBytes +
    stats.treeObjects * 1_024 +
    MAX_MERGE_MESSAGE_BYTES +
    4 * MAX_MERGE_IDENTITY_BYTES +
    1_024;
  const payloadPages = Math.max(1, Math.ceil(payloadBytes / MERGE_OBJECT_BATCH_BYTES));
  const flushes = Math.ceil(objects / MERGE_OBJECT_BATCH_COUNT) + payloadPages;
  const indexedRows = stats.leafEntries + stats.treeObjects - 1;
  return (
    20 +
    flushes * 6 +
    payloadPages * 2 +
    Math.ceil(indexedRows / MERGE_TREE_INDEX_ROWS) * 2 +
    Math.ceil(stats.treeObjects / MERGE_TREE_INDEX_ROWS) * 2 +
    Math.ceil(stats.leafEntries / 2_048)
  );
}

const MERGE_COMMIT_SQL_STATEMENTS = commitSqlStatements({
  leafEntries: MAX_MERGE_INDEX_ENTRIES,
  totalPathBytes: MAX_MERGE_INDEX_PATH_BYTES,
  treeObjects: MAX_MERGE_TREE_OBJECTS,
  serializedTreeBytes: MAX_MERGE_SERIALIZED_TREE_BYTES,
  maxSingleTreeBytes: MAX_MERGE_SERIALIZED_TREE_BYTES,
});

function synthesizeVirtualPair(
  repo: Repository,
  currentOid: string,
  incomingOid: string,
  budget: VirtualBudget,
  depth: number,
): string {
  const selection = selectMergeBases(repo, { currentOid, incomingOid });
  budget.sqlStatements += selection.sqlStatements;
  if (selection.kind === "already-merged") return currentOid;
  if (selection.kind === "fast-forward") return incomingOid;
  if (selection.kind === "shallow") {
    throw new GitError("ESHALLOW", "cannot synthesize a merge base across a shallow boundary");
  }
  if (selection.kind === "unrelated") {
    throw new GitError("EUNRELATED", "cannot synthesize unrelated merge bases");
  }
  budget.commits++;
  if (budget.commits > MAX_VIRTUAL_COMMITS) {
    throw new GitError(
      "E2BIG",
      `recursive merge-base synthesis exceeds ${MAX_VIRTUAL_COMMITS} temporary commits`,
    );
  }
  const baseCommit = synthesizeVirtualBases(repo, selection.bases, budget, depth + 1);
  const plan = planVirtualAncestorIntegration(repo, {
    baseTreeOid: commitTree(repo, baseCommit),
    currentTreeOid: commitTree(repo, currentOid),
    incomingTreeOid: commitTree(repo, incomingOid),
    labels: { current: "Temporary merge branch 1", incoming: "Temporary merge branch 2" },
    depth,
  });
  budget.sqlStatements += integrationSqlStatements(plan, MAX_VIRTUAL_ANCESTOR_TREE_STATEMENTS);
  const reservation = reservePlan(repo, plan);
  try {
    budget.sqlStatements += virtualMaterializationStatements(repo, currentOid, incomingOid, plan);
    if (budget.sqlStatements >= 1_000) {
      throw new GitError(
        "E2BIG",
        `recursive merge-base SQL model requires ${budget.sqlStatements} statements`,
      );
    }
    return materializeVirtualCommit(repo, currentOid, incomingOid, plan);
  } finally {
    reservation.dispose();
  }
}

function synthesizeVirtualBases(
  repo: Repository,
  bases: readonly string[],
  budget: VirtualBudget,
  depth: number,
): string {
  const first = bases[0];
  if (first === undefined) throw new GitError("EUNRELATED", "merge base list is empty");
  let current = first;
  for (let index = 1; index < bases.length; index++) {
    const incoming = bases[index];
    if (incoming === undefined) throw new GitError("ECORRUPT", "merge base list has a hole");
    current = synthesizeVirtualPair(repo, current, incoming, budget, depth);
  }
  return current;
}

function selectedBaseTree(
  repo: Repository,
  bases: readonly string[],
  budget: VirtualBudget,
): string {
  return commitTree(repo, synthesizeVirtualBases(repo, bases, budget, 1));
}

function requireBoundedTreeEntries(entries: Iterable<IndexEntry>): TreeBuildPreflightStats {
  return preflightTreeBuild(entries, {
    maxLeafEntries: MAX_MERGE_INDEX_ENTRIES,
    maxTotalPathBytes: MAX_MERGE_INDEX_PATH_BYTES,
    maxTreeObjects: MAX_MERGE_TREE_OBJECTS,
    maxSerializedTreeBytes: MAX_MERGE_SERIALIZED_TREE_BYTES,
  });
}

function projectedIdentity(entry: ProjectedMergeEntry): { mode: string; oid: string } | null {
  if (entry.stageZero !== null) return entry.stageZero;
  if (entry.stages === null) return null;
  return entry.stages.current ?? entry.stages.incoming ?? entry.stages.base;
}

function* prospectiveIndexEntries(
  repo: Repository,
  projected: readonly ProjectedMergeEntry[],
): Generator<IndexEntry> {
  const owned = new Set(projectedTouchedShape(projected).map((entry) => entry.path));
  for (const row of joinSorted(repo.store.indexScan(), projected, {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    if (row.right !== undefined) {
      const identity = projectedIdentity(row.right);
      if (identity !== null) yield indexEntry(row.right.path, identity.mode, identity.oid);
      continue;
    }
    if (row.left !== undefined && !owned.has(row.left.path)) yield row.left;
  }
}

function* continuationIndexEntries(repo: Repository): Generator<IndexEntry> {
  let previous: string | null = null;
  for (const entry of repo.store.indexScan()) {
    if (entry.path === previous) continue;
    previous = entry.path;
    yield entry.stage === 0 ? entry : { ...entry, stage: 0 };
  }
}

function requireBoundedIndex(repo: Repository): void {
  requireBoundedTreeEntries(continuationIndexEntries(repo));
}

function reservePlan(
  repo: Repository,
  plan: IntegrationPlan,
): ReturnType<Repository["store"]["reserveMemory"]> {
  const reservation = repo.store.reserveMemory();
  reservation.set("other", plan.retainedBytes + MERGE_EXECUTION_HEADROOM_BYTES);
  return reservation;
}

function reserveExecutionHeadroom(
  repo: Repository,
): ReturnType<Repository["store"]["reserveMemory"]> {
  const reservation = repo.store.reserveMemory();
  reservation.set("other", MERGE_EXECUTION_HEADROOM_BYTES);
  return reservation;
}

function requireCleanIndex(repo: Repository, headTree: string): void {
  if (repo.store.hasConflicts()) {
    throw new GitError("EUNMERGED", "cannot merge with unmerged index entries");
  }
  for (const row of joinSorted(treeStream(repo, headTree), repo.store.indexScan(), {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    const tree = row.left;
    const index = row.right;
    if (
      tree === undefined ||
      index === undefined ||
      index.stage !== 0 ||
      index.oid !== tree.oid ||
      index.mode !== Number.parseInt(tree.mode, 8)
    ) {
      throw new GitError("ECHECKOUTFAIL", "cannot merge: the index contains staged changes");
    }
  }
}

function requireSafeWorktree(
  repo: Repository,
  worktree: Worktree,
  incomingTree: string,
  paths: readonly string[],
): void {
  if (paths.length === 0) return;
  const blockers = checkoutBlockers(repo, worktree, incomingTree, [...paths], true, {
    maxRows: MAX_MERGE_REPOSITORY_ROWS,
    maxHashBytes: MAX_MERGE_GUARD_HASH_BYTES,
    rows: 0,
    hashBytes: 0,
    maxHashRangeReads: 30,
    hashRangeReads: 0,
    maxHashCandidates: 1_000,
    hashCandidates: 0,
    maxHashBatches: 1,
    hashBatches: 0,
  });
  if (blockers.tracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `local changes to ${blockers.tracked.join(", ")} would be overwritten by merge`,
    );
  }
  if (blockers.untracked.length > 0) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `untracked working tree files would be overwritten by merge: ${blockers.untracked.join(", ")}`,
    );
  }
}

function relocationBases(entries: readonly ProjectedMergeEntry[]): string[] {
  return entries.flatMap((entry) => (entry.purpose === "primary" ? [] : [entry.path]));
}

function collisionCandidate(base: string, path: string): string | null {
  if (path === base || path.startsWith(`${base}/`)) return base;
  if (!path.startsWith(`${base}_`)) return null;
  let end = base.length + 1;
  while (end < path.length && path.charCodeAt(end) >= 0x30 && path.charCodeAt(end) <= 0x39) end++;
  if (end === base.length + 1 || (end < path.length && path.charCodeAt(end) !== 0x2f)) return null;
  return path.slice(0, end);
}

function retainCollision(path: string, bases: readonly string[], collisions: Set<string>): void {
  for (const base of bases) {
    const candidate = collisionCandidate(base, path);
    if (candidate === null || collisions.has(candidate)) continue;
    if (collisions.size >= MAX_RELOCATION_COLLISIONS) {
      throw new GitError(
        "E2BIG",
        `merge relocation collisions exceed ${MAX_RELOCATION_COLLISIONS} paths`,
      );
    }
    collisions.add(candidate);
  }
}

function relocationCollisions(
  repo: Repository,
  worktree: Worktree,
  baseTree: string,
  incomingTree: string,
  initial: readonly ProjectedMergeEntry[],
  omitted: ReadonlySet<string>,
): { tracked: ReadonlySet<string>; untracked: ReadonlySet<string> } {
  const bases = relocationBases(initial);
  if (bases.length === 0) return { tracked: new Set(), untracked: new Set() };
  const tracked = new Set<string>();
  let indexRows = 0;
  for (const entry of repo.store.indexScan()) {
    if (indexRows >= MAX_MERGE_REPOSITORY_ROWS) {
      throw new GitError("E2BIG", `merge collision scan exceeds ${MAX_MERGE_REPOSITORY_ROWS} rows`);
    }
    indexRows++;
    if (!omitted.has(entry.path)) retainCollision(entry.path, bases, tracked);
  }
  for (const entry of treeStream(repo, baseTree)) retainCollision(entry.path, bases, tracked);
  for (const entry of treeStream(repo, incomingTree)) retainCollision(entry.path, bases, tracked);

  const untracked = new Set<string>();
  let worktreeRows = 0;
  for (const row of joinSorted(
    repo.store.indexScan(),
    walkWorktreeEntriesStream(worktree, repo.root, { includeIgnored: true }),
    { left: (entry) => entry.path, right: (entry) => entry.path },
  )) {
    if (worktreeRows >= MAX_MERGE_REPOSITORY_ROWS) {
      throw new GitError("E2BIG", `merge collision scan exceeds ${MAX_MERGE_REPOSITORY_ROWS} rows`);
    }
    worktreeRows++;
    if (omitted.has(row.path)) continue;
    if (row.right !== undefined && row.left === undefined) {
      retainCollision(row.path, bases, untracked);
    }
  }
  return { tracked, untracked };
}

function projectWithCollisions(
  repo: Repository,
  worktree: Worktree,
  baseTree: string,
  incomingTree: string,
  plan: ReturnType<typeof planIntegration>,
  currentLabel: string,
  nextLabel: string,
  omitted: ReadonlySet<string> = new Set(),
): readonly ProjectedMergeEntry[] {
  const initial = projectMergePlan(plan, { currentLabel, incomingLabel: nextLabel });
  const collisions = relocationCollisions(repo, worktree, baseTree, incomingTree, initial, omitted);
  return projectMergePlan(plan, {
    currentLabel,
    incomingLabel: nextLabel,
    trackedCollisions: collisions.tracked,
    untrackedCollisions: collisions.untracked,
  });
}

interface TouchedShape {
  path: string;
  logicalPath: string;
  purpose: MergeTouchedPath["purpose"];
}

function projectedTouchedShape(entries: readonly ProjectedMergeEntry[]): TouchedShape[] {
  const byPath = new Map<string, TouchedShape>();
  const retain = (shape: TouchedShape): void => {
    if (byPath.has(shape.path)) return;
    if (byPath.size >= 1_000) {
      throw new GitError("E2BIG", "merge ownership exceeds 1000 touched paths");
    }
    byPath.set(shape.path, shape);
  };
  const retainAncestor = (path: string): void => {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const ancestor = path.slice(0, slash);
      retain({ path: ancestor, logicalPath: ancestor, purpose: "primary" });
      slash = ancestor.lastIndexOf("/");
    }
  };
  for (const entry of entries) {
    retain({
      path: entry.path,
      logicalPath: entry.logicalPath,
      purpose: entry.purpose,
    });
    if (entry.purpose !== "primary" && !byPath.has(entry.logicalPath)) {
      retain({
        path: entry.logicalPath,
        logicalPath: entry.logicalPath,
        purpose: "primary",
      });
    }
    retainAncestor(entry.path);
    retainAncestor(entry.logicalPath);
  }
  return [...byPath.values()].sort((left, right) => comparePaths(left.path, right.path));
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
  tailSqlStatements: number,
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
  const budget: VirtualBudget = {
    commits: 0,
    sqlStatements:
      selection.sqlStatements + MERGE_FIXED_SQL_STATEMENTS + MERGE_COLLISION_SQL_STATEMENTS,
  };
  const baseTree = selectedBaseTree(repo, selection.bases, budget);
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
  budget.sqlStatements += integrationSqlStatements(plan, MAX_INTEGRATION_TREE_STATEMENTS);
  if (budget.sqlStatements + tailSqlStatements >= 1_000) {
    throw new GitError("E2BIG", "merge recovery SQL model exceeds 999 statements");
  }
  const reservation = reservePlan(repo, plan);
  try {
    const omitted = new Set(journal.touched.map((entry) => entry.path));
    const projected = projectWithCollisions(
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
): Omit<MergeStateMetadata, "phase"> {
  return {
    originalHeadRef: head.ref,
    originalHeadOid: head.oid,
    currentParentOid: head.oid,
    incomingParentOid: incomingOid,
    mode: options.commit === false ? "no-commit" : "commit",
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
  repo.store.requireNoMergeState();
  const rawHead = requireCurrentHead(repo, ours);
  if (rawHead.ref === null || rawHead.oid === null) throw new GitError("ECORRUPT", "invalid HEAD");
  const head = { ref: rawHead.ref, oid: rawHead.oid };
  if (repo.store.hasConflicts()) {
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
  const budget: VirtualBudget = {
    commits: 0,
    sqlStatements:
      selection.sqlStatements + MERGE_FIXED_SQL_STATEMENTS + MERGE_GUARD_SQL_STATEMENTS,
  };
  if (!isFastForward) {
    requireBoundedIndex(repo);
    requireCleanIndex(repo, currentTree);
    budget.sqlStatements += MERGE_INDEX_SQL_STATEMENTS;
  }
  const baseTree = isFastForward ? currentTree : selectedBaseTree(repo, selection.bases, budget);
  const plan = planIntegration(repo, {
    baseTreeOid: baseTree,
    currentTreeOid: currentTree,
    incomingTreeOid: nextTree,
    text: { labels: { current: currentLabel, base: "base", incoming: nextLabel } },
  });
  budget.sqlStatements += integrationSqlStatements(plan, MAX_INTEGRATION_TREE_STATEMENTS);
  const reservation = reservePlan(repo, plan);
  try {
    const projected = projectWithCollisions(
      repo,
      worktree,
      baseTree,
      nextTree,
      plan,
      currentLabel,
      nextLabel,
    );
    if (projected.some((entry) => entry.purpose !== "primary")) {
      budget.sqlStatements += MERGE_COLLISION_SQL_STATEMENTS;
    }
    requireSafeWorktree(
      repo,
      worktree,
      nextTree,
      plan.entries.map((entry) => entry.path),
    );
    const conflicts = conflictedPaths(projected);
    if (conflicts.length > 0 && behavior.persistConflicts === false) {
      throw compatibilityConflict(conflicts);
    }
    let projectedTree: TreeBuildPreflightStats | null = null;
    if (!isFastForward) {
      projectedTree = requireBoundedTreeEntries(prospectiveIndexEntries(repo, projected));
      if (conflicts.length === 0 && options.commit !== false) {
        budget.sqlStatements += commitSqlStatements(projectedTree);
      }
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
    );
    mergeMetadata.message = messageWithConflicts(mergeMetadata.message, conflicts);
    const applied = applyProjectedMerge(repo, worktree, projected, mergeMetadata, {
      priorSqlStatements: budget.sqlStatements,
    });
    if (isFastForward) {
      repo.store.setRef(head.ref, incomingOid);
      return { oid: incomingOid, fastForward: true };
    }
    requireBoundedIndex(repo);
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
    return commitIndex(repo, {
      message: mergeMetadata.message,
      parent: [head.oid, incomingOid],
      identities,
      expectedHead: head,
    });
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
    const journal = repo.store.requireMergeState();
    const head = requireOriginalHead(repo, journal.state);
    requireJournalOwnership(
      repo,
      context.worktree,
      journal,
      MERGE_COMMIT_SQL_STATEMENTS + MERGE_INDEX_SQL_STATEMENTS,
    );
    if (repo.store.hasConflicts()) {
      throw new GitError("EUNMERGED", "cannot continue: the index has unmerged paths");
    }
    requireBoundedIndex(repo);
    const reservation = reserveExecutionHeadroom(repo);
    try {
      const identities = resolveIdentity(context, repo, {
        author: options.author ?? journal.state.author ?? undefined,
        committer: options.committer ?? journal.state.committer ?? undefined,
        env: options.env,
      });
      const message = options.message ?? journal.state.message;
      validateMergeCommitInput(journal.state, message, identities);
      const result = commitIndex(repo, {
        message,
        parent: [journal.state.currentParentOid, journal.state.incomingParentOid],
        identities,
        expectedHead: head,
      });
      repo.store.clearMergeState();
      return result;
    } finally {
      reservation.dispose();
    }
  });
}

/** Restore only paths owned by the active merge and clear its durable state. */
export function mergeAbort(repo: Repository, worktree: Worktree): void {
  repo.store.db.transactionSync(() => {
    const journal = repo.store.requireMergeState();
    requireOriginalHead(repo, journal.state);
    requireJournalOwnership(repo, worktree, journal, 350);
    const reservation = reserveExecutionHeadroom(repo);
    try {
      abortProjectedMerge(repo, worktree, journal);
    } finally {
      reservation.dispose();
    }
  });
}
