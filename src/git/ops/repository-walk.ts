import { CorruptError, GitError, hasErrorCode, ObjectNotFoundError } from "../common/errors.js";
import type { Commit } from "../common/objects.js";
import {
  COMMIT_CACHE_FLUSH_BYTES,
  type CommitCacheEntry,
  type CommitGraphLimits,
  MAX_LOG_COMMITS,
  prepareCommitCacheOwned,
  readCommitGraphOwned,
} from "../store/commits.js";
import type { SharedRepoStore } from "../store/index.js";
import { readShallowOwned } from "../store/index.js";
import { sharedRepoStoreMutations } from "../store/shared.js";

interface WalkNode {
  oid: string;
  commit: Commit;
  sequence: number;
}

function before(left: WalkNode, right: WalkNode): boolean {
  if (left.commit.committer.timestamp !== right.commit.committer.timestamp) {
    return left.commit.committer.timestamp > right.commit.committer.timestamp;
  }
  return left.sequence < right.sequence;
}

class CommitHeap {
  readonly #nodes: WalkNode[] = [];

  get size(): number {
    return this.#nodes.length;
  }

  push(node: WalkNode): void {
    let index = this.#nodes.length;
    this.#nodes.push(node);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (before(this.#nodes[parent]!, node)) break;
      this.#nodes[index] = this.#nodes[parent]!;
      index = parent;
    }
    this.#nodes[index] = node;
  }

  pop(): WalkNode | undefined {
    const first = this.#nodes[0];
    const tail = this.#nodes.pop();
    if (first === undefined || tail === undefined || this.#nodes.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.#nodes.length) break;
      const right = left + 1;
      const child =
        right < this.#nodes.length && before(this.#nodes[right]!, this.#nodes[left]!)
          ? right
          : left;
      if (before(tail, this.#nodes[child]!)) break;
      this.#nodes[index] = this.#nodes[child]!;
      index = child;
    }
    this.#nodes[index] = tail;
    return first;
  }
}

class CommitFillBuffer {
  readonly #pending: CommitCacheEntry[] = [];
  #bytes = 0;

  constructor(private readonly store: SharedRepoStore) {}

  add(entry: CommitCacheEntry): void {
    if (
      entry.cacheBytes > COMMIT_CACHE_FLUSH_BYTES ||
      (this.#pending.length > 0 && this.#bytes + entry.cacheBytes > COMMIT_CACHE_FLUSH_BYTES)
    ) {
      this.flush();
    }
    if (entry.cacheBytes > COMMIT_CACHE_FLUSH_BYTES) return;
    this.#pending.push(entry);
    this.#bytes += entry.cacheBytes;
    if (this.#bytes >= COMMIT_CACHE_FLUSH_BYTES) this.flush();
  }

  flush(): void {
    sharedRepoStoreMutations(this.store).cacheCommitsOwned(this.#pending);
    this.#pending.length = 0;
    this.#bytes = 0;
  }
}

interface WalkRepository {
  readonly store: SharedRepoStore;
  peel(oid: string): string;
  readAuthenticatedCommitOwned(oid: string): Commit;
  shallow(): Set<string>;
}

export interface PrunedCommitWalkDecision {
  include: boolean;
  parents: readonly string[];
}

/** Read, hash, and parse a commit from its authoritative physical source. */
export function readAuthenticatedCommitOwned(store: SharedRepoStore, oid: string): Commit {
  return readAuthenticatedCommitEntryOwned(store, oid).commit;
}

export function readCommitOwned(store: SharedRepoStore, oid: string): Commit {
  return readCommitEntryOwned(store, oid).commit;
}

export function authenticateCommitGraphThroughBoundary(
  repo: WalkRepository,
  roots: Iterable<string>,
  boundary: ReadonlySet<string>,
): Set<string> {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const commits = new Map<string, Commit>();
  for (const root of roots) {
    if (visited.has(root)) continue;
    const stack: { oid: string; parent: number }[] = [{ oid: root, parent: 0 }];
    visiting.add(root);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      let commit = commits.get(frame.oid);
      if (commit === undefined) {
        if (commits.size >= MAX_LOG_COMMITS) {
          throw new GitError("E2BIG", "commit graph exceeds the 50000 commit limit");
        }
        commit = repo.readAuthenticatedCommitOwned(frame.oid);
        commits.set(frame.oid, commit);
      }
      const parents = boundary.has(frame.oid) ? [] : commit.parent;
      if (frame.parent >= parents.length) {
        stack.pop();
        visiting.delete(frame.oid);
        visited.add(frame.oid);
        continue;
      }
      const parent = parents[frame.parent++]!;
      if (visiting.has(parent)) throw new CorruptError("commit graph contains a cycle");
      if (visited.has(parent)) continue;
      visiting.add(parent);
      stack.push({ oid: parent, parent: 0 });
    }
  }
  return visited;
}

function readAuthenticatedCommitEntryOwned(store: SharedRepoStore, oid: string): CommitCacheEntry {
  const metadata = store.typeAndSize(oid);
  if (metadata === null) throw new ObjectNotFoundError(oid);
  if (metadata.type !== "commit") {
    throw new CorruptError(`${oid} is a ${metadata.type}, not a commit`);
  }
  const object = store.readAuthenticatedObject(oid, "commit");
  if (object === null) throw new ObjectNotFoundError(oid);
  if (object.data.length !== metadata.size) {
    throw new CorruptError(`commit ${oid} does not match its authoritative size`);
  }
  return prepareCommitCacheOwned({ repoId: store.repoId, oid, data: object.data });
}

function readCommitEntryOwned(
  store: SharedRepoStore,
  oid: string,
  fill?: CommitFillBuffer,
): CommitCacheEntry {
  const cached = store.cachedCommit(oid);
  if (cached !== null) return cached;
  const prepared = readAuthenticatedCommitEntryOwned(store, oid);
  if (fill === undefined) {
    if (prepared.cacheBytes <= COMMIT_CACHE_FLUSH_BYTES) {
      sharedRepoStoreMutations(store).cacheCommitsOwned([prepared]);
    }
  } else {
    fill.add(prepared);
  }
  return prepared;
}

/** Commits reachable from `oid`, first-parent-first, in commit-date order. */
export function* walkOwned(
  repo: WalkRepository,
  oid: string,
): Generator<{ oid: string; commit: Commit }> {
  const fill = new CommitFillBuffer(repo.store);
  try {
    const seen = new Set<string>();
    const queue = new CommitHeap();
    let sequence = 0;
    const push = (candidate: string): void => {
      if (seen.has(candidate)) return;
      if (seen.size >= MAX_LOG_COMMITS) {
        throw new GitError("E2BIG", "commit graph exceeds the 50000 commit limit");
      }
      const entry = readCommitEntryOwned(repo.store, candidate, fill);
      seen.add(candidate);
      queue.push({ oid: candidate, commit: entry.commit, sequence: sequence++ });
    };

    push(repo.peel(oid));
    const boundary = readShallowOwned(repo.store);
    while (queue.size > 0) {
      const next = queue.pop();
      if (next === undefined) throw new CorruptError("commit graph heap lost its next row");
      yield { oid: next.oid, commit: next.commit };
      if (boundary.has(next.oid)) continue;
      for (const parent of next.commit.parent) push(parent);
    }
  } finally {
    fill.flush();
  }
}

export function* walkPrunedOwned(
  repo: WalkRepository,
  oid: string,
  select: (entry: { oid: string; commit: Commit }) => PrunedCommitWalkDecision,
): Generator<{ oid: string; commit: Commit; include: boolean }> {
  const fill = new CommitFillBuffer(repo.store);
  try {
    const seen = new Set<string>();
    const queue = new CommitHeap();
    let sequence = 0;
    const push = (candidate: string): void => {
      if (seen.has(candidate)) return;
      if (seen.size >= MAX_LOG_COMMITS) {
        throw new GitError("E2BIG", "commit graph exceeds the 50000 commit limit");
      }
      const entry = readCommitEntryOwned(repo.store, candidate, fill);
      seen.add(candidate);
      queue.push({ oid: candidate, commit: entry.commit, sequence: sequence++ });
    };

    push(repo.peel(oid));
    const boundary = readShallowOwned(repo.store);
    while (queue.size > 0) {
      const next = queue.pop();
      if (next === undefined) throw new CorruptError("commit graph heap lost its next row");
      const decision = select({ oid: next.oid, commit: next.commit });
      yield { oid: next.oid, commit: next.commit, include: decision.include };
      if (boundary.has(next.oid)) continue;
      for (const parent of decision.parents) {
        if (!next.commit.parent.includes(parent)) {
          throw new CorruptError("pruned commit walk selected a non-parent oid");
        }
        push(parent);
      }
    }
  } finally {
    fill.flush();
  }
}

/** Fully validated indexed graph walk used by large and unbounded logs. */
export function* walkIndexedOwned(
  repo: WalkRepository,
  oid: string,
  limits: CommitGraphLimits = {},
): Generator<{ oid: string; commit: Commit }> {
  const root = repo.peel(oid);
  const boundary = readShallowOwned(repo.store);
  const entries = new Map<string, CommitCacheEntry>();
  const maxCommits = Math.min(limits.maxCommits ?? MAX_LOG_COMMITS, MAX_LOG_COMMITS);
  try {
    try {
      for (const entry of readCommitGraphOwned(repo.store.db, repo.store.repoId, root, limits)) {
        if (entries.has(entry.oid)) {
          throw new CorruptError("commit graph yielded a duplicate oid");
        }
        if (entries.size >= maxCommits) {
          throw new GitError("E2BIG", "commit graph exceeds the 50000 commit limit");
        }
        entries.set(entry.oid, entry);
      }
    } catch (error) {
      if (!hasErrorCode(error, "ECACHEMISS")) throw error;
      yield* walkUncachedOwned(repo.store, root, boundary, limits);
      return;
    }
    if (!entries.has(root)) throw new CorruptError("commit graph omitted its cached root");
    validateCommitGraph(root, entries, boundary, true);
    yield* orderedCommitGraph(root, entries, boundary);
  } finally {
    entries.clear();
  }
}

function* walkUncachedOwned(
  store: SharedRepoStore,
  root: string,
  boundary: ReadonlySet<string>,
  limits: CommitGraphLimits,
): Generator<{ oid: string; commit: Commit }> {
  const entries = new Map<string, CommitCacheEntry>();
  const pending = [root];
  const maxCommits = Math.min(limits.maxCommits ?? MAX_LOG_COMMITS, MAX_LOG_COMMITS);
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined || entries.has(candidate)) continue;
    if (entries.size >= maxCommits) {
      throw new GitError("E2BIG", "commit graph exceeds the 50000 commit limit");
    }
    const entry = readAuthenticatedCommitEntryOwned(store, candidate);
    entries.set(candidate, entry);
    if (!boundary.has(candidate)) {
      for (const parent of entry.commit.parent) pending.push(parent);
    }
  }
  if (!entries.has(root)) throw new CorruptError("commit graph omitted its root");
  validateCommitGraph(root, entries, boundary, true);
  yield* orderedCommitGraph(root, entries, boundary);
}

function* orderedCommitGraph(
  root: string,
  entries: ReadonlyMap<string, CommitCacheEntry>,
  boundary: ReadonlySet<string>,
): Generator<{ oid: string; commit: Commit }> {
  const seen = new Set<string>();
  const queue = new CommitHeap();
  let sequence = 0;
  const push = (candidate: string): void => {
    if (seen.has(candidate)) return;
    const entry = entries.get(candidate);
    if (entry === undefined) throw new CorruptError("commit graph is missing a parent row");
    seen.add(candidate);
    queue.push({ oid: candidate, commit: entry.commit, sequence: sequence++ });
  };
  push(root);
  while (queue.size > 0) {
    const next = queue.pop();
    if (next === undefined) throw new CorruptError("commit graph heap lost its next row");
    yield { oid: next.oid, commit: next.commit };
    if (boundary.has(next.oid)) continue;
    for (const parent of next.commit.parent) push(parent);
  }
}

/** Validate only edges present in a bounded point walk; the depth frontier is intentional. */
export function validateCommitWalk(
  repo: WalkRepository,
  entries: readonly { oid: string; commit: Commit }[],
): void {
  const indexed = new Map<string, { commit: Commit }>();
  for (const entry of entries) {
    if (indexed.has(entry.oid)) throw new CorruptError("commit walk yielded a duplicate oid");
    indexed.set(entry.oid, { commit: entry.commit });
  }
  const root = entries[0]?.oid;
  if (root === undefined) return;
  validateCommitGraph(root, indexed, repo.shallow(), false);
}

function validateCommitGraph(
  root: string,
  entries: ReadonlyMap<string, { commit: Commit }>,
  boundary: ReadonlySet<string>,
  requireComplete: boolean,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: { oid: string; parent: number }[] = [{ oid: root, parent: 0 }];
  visiting.add(root);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const entry = entries.get(frame.oid);
    if (entry === undefined) throw new CorruptError("commit graph is missing a commit row");
    const parents = boundary.has(frame.oid) ? [] : entry.commit.parent;
    if (frame.parent >= parents.length) {
      stack.pop();
      visiting.delete(frame.oid);
      visited.add(frame.oid);
      continue;
    }
    const parent = parents[frame.parent++]!;
    if (!entries.has(parent)) {
      if (requireComplete) throw new CorruptError("commit graph is missing a parent row");
      continue;
    }
    if (visiting.has(parent)) throw new CorruptError("commit graph contains a cycle");
    if (visited.has(parent)) continue;
    visiting.add(parent);
    stack.push({ oid: parent, parent: 0 });
  }
  if (requireComplete && visited.size !== entries.size) {
    throw new CorruptError("commit graph has unreachable rows");
  }
}
