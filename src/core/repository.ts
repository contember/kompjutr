// The repository: everything reachable from the object store and the refs,
// with no knowledge of Computer, DOFS or HTTP.

import {
  type CommitCacheEntry,
  type CommitGraphLimits,
  MAX_COMMIT_CACHE_BYTES,
  MAX_LOG_COMMITS,
  MAX_LOG_STATE_BYTES,
} from "../sqlite/commits.js";
import type {
  BlobReadBatch,
  CheckoutStore,
  FetchPublicationPlan,
  FetchPublicationToken,
  ObjectReadBatch,
  RefLogEntry,
  RefLogMetadata,
  RefLogReadOptions,
  RefMutation,
  SharedRepoStore,
  WalkTreeDiffEntry,
  WalkTreeDiffObject,
} from "../sqlite/store.js";
import { isAbbreviatedOid, isOid } from "./bytes.js";
import { CorruptError, GitError, ObjectNotFoundError, RefNotFoundError } from "./errors.js";
import {
  type Commit,
  isTreeMode,
  type ObjectType,
  parseCommit,
  parseTag,
  parseTree,
  type RawObject,
  type Tag,
  type TreeEntry,
} from "./objects.js";

/** Where a short ref name is looked up, in git's own order. */
const REF_SEARCH = [
  (name: string) => name,
  (name: string) => `refs/${name}`,
  (name: string) => `refs/tags/${name}`,
  (name: string) => `refs/heads/${name}`,
  (name: string) => `refs/remotes/${name}`,
  (name: string) => `refs/remotes/${name}/HEAD`,
];

const MAX_REVISION_EXPRESSION_UNITS = 1_024;
const MAX_REVISION_TRAVERSALS = 32;
const MAX_HEAD_REFLOG_INDEX = 1_023;

function boundedDecimal(digits: string, maximum: number): number | null {
  if (digits === "") return null;
  let value = 0;
  for (let index = 0; index < digits.length; index++) {
    const digit = digits.charCodeAt(index) - 0x30;
    if (digit < 0 || digit > 9) return null;
    if (value > Math.floor((maximum - digit) / 10)) return null;
    value = value * 10 + digit;
  }
  return value;
}

export interface ResolvedHead {
  /** Full ref name HEAD points at, or null when detached. */
  ref: string | null;
  /** The commit HEAD resolves to, or null on an unborn branch. */
  oid: string | null;
}

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
    if (this.#pending.length > 0 && this.#bytes + entry.cacheBytes > MAX_COMMIT_CACHE_BYTES) {
      this.flush();
    }
    this.#pending.push(entry);
    this.#bytes += entry.cacheBytes;
    if (this.#bytes >= MAX_COMMIT_CACHE_BYTES) this.flush();
  }

  flush(): void {
    if (this.#pending.length === 0) return;
    this.store.cacheCommits(this.#pending);
    this.#pending.length = 0;
    this.#bytes = 0;
  }
}

export class Repository {
  readonly store: SharedRepoStore;

  constructor(readonly checkout: CheckoutStore) {
    this.store = checkout.shared;
  }

  get root(): string {
    return this.checkout.root;
  }

  /** Commits whose parents this repository deliberately does not have. */
  shallow(): Set<string> {
    return this.store.shallow();
  }

  invalidateShallow(): void {
    this.store.invalidateShallow();
  }

  // -- objects --------------------------------------------------------

  read(oid: string): RawObject {
    const object = this.store.read(oid);
    if (object === null) throw new ObjectNotFoundError(oid);
    return object;
  }

  has(oid: string): boolean {
    return this.store.has(oid);
  }

  typeOf(oid: string): ObjectType {
    const found = this.store.typeAndSize(oid);
    if (found === null) throw new ObjectNotFoundError(oid);
    return found.type;
  }

  readCommit(oid: string): Commit {
    return this.#readCommitEntry(oid).commit;
  }

  /** Read, hash, and parse a commit from its authoritative physical source. */
  readAuthenticatedCommit(oid: string): Commit {
    const object = this.store.readAuthenticatedObject(oid, "commit");
    if (object === null) throw new ObjectNotFoundError(oid);
    return this.store.prepareCommit(oid, object.data).commit;
  }

  #readCommitEntry(oid: string, fill?: CommitFillBuffer): CommitCacheEntry {
    const cached = this.store.cachedCommit(oid);
    if (cached !== null) return cached;
    const object = this.read(oid);
    if (object.type !== "commit")
      throw new CorruptError(`${oid} is a ${object.type}, not a commit`);
    const prepared = this.store.prepareCommit(oid, object.data);
    if (fill === undefined) this.store.cacheCommits([prepared]);
    else fill.add(prepared);
    return prepared;
  }

  readTree(oid: string): TreeEntry[] {
    const object = this.read(oid);
    if (object.type === "commit") return this.readTree(parseCommit(object.data).tree);
    if (object.type !== "tree") throw new CorruptError(`${oid} is a ${object.type}, not a tree`);
    return parseTree(object.data);
  }

  readBlob(oid: string): Uint8Array {
    const object = this.read(oid);
    if (object.type !== "blob") throw new CorruptError(`${oid} is a ${object.type}, not a blob`);
    return object.data;
  }

  /** Read a bounded prefix of blobs without scalar object lookups. */
  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    return this.store.readBlobs(oids, options);
  }

  /** Read a bounded prefix of mixed objects without scalar lookups. */
  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    return this.store.readObjects(oids, options);
  }

  /** Objects introduced by one tree transition, with equal subtrees pruned. */
  *walkTreeDiffObjects(
    beforeTreeOid: string | null,
    afterTreeOid: string,
  ): Generator<WalkTreeDiffObject> {
    yield* this.store.walkTreeDiffObjects(beforeTreeOid, afterTreeOid);
  }

  readTag(oid: string): Tag {
    const object = this.read(oid);
    if (object.type !== "tag") throw new CorruptError(`${oid} is a ${object.type}, not a tag`);
    return parseTag(object.data);
  }

  /** Follow annotated tags down to the object they ultimately name. */
  peel(oid: string, want: ObjectType = "commit"): string {
    let current = oid;
    for (let hops = 0; hops < 16; hops++) {
      const type = this.typeOf(current);
      if (type === want || type !== "tag") return current;
      current = this.readTag(current).object;
    }
    throw new CorruptError(`tag chain from ${oid} is too deep`);
  }

  // -- refs -----------------------------------------------------------

  /** The full name of the ref `name` denotes, or null. */
  expandRef(name: string): string | null {
    if (name === "HEAD") return "HEAD";
    for (const candidate of REF_SEARCH) {
      const full = candidate(name);
      if (this.store.getRef(full) !== null) return full;
    }
    return null;
  }

  /** Resolve a ref name (following symrefs) to an oid, or null. */
  resolveRef(name: string): string | null {
    let current = name;
    for (let hops = 0; hops < 8; hops++) {
      const full = this.expandRef(current);
      if (full === null) return null;
      const value = full === "HEAD" ? this.checkout.head() : this.store.getRef(full);
      if (value === null) return null;
      if (value.startsWith("ref: ")) {
        current = value.slice(5).trim();
        continue;
      }
      return value;
    }
    throw new CorruptError(`symbolic ref loop at ${name}`);
  }

  head(): ResolvedHead {
    const raw = this.checkout.head();
    if (raw.startsWith("ref: ")) {
      const ref = raw.slice(5).trim();
      const value = this.store.getRef(ref);
      return { ref, oid: value === null ? null : value };
    }
    return { ref: null, oid: isOid(raw) ? raw : null };
  }

  branches(): string[] {
    return this.store.listRefs("refs/heads/").map((row) => row.name.slice("refs/heads/".length));
  }

  tags(): string[] {
    return this.store.listRefs("refs/tags/").map((row) => row.name.slice("refs/tags/".length));
  }

  reflog(ref = "HEAD", options: RefLogReadOptions = {}): RefLogEntry[] {
    return ref === "HEAD" ? this.checkout.reflog(ref, options) : this.store.reflog(ref, options);
  }

  mutateRefs(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    return this.checkout.mutateRefs(mutation, metadata);
  }

  beginFetchPublication(
    trackingPrefix: string,
    candidateGlobalRefs: Iterable<string> = [],
  ): FetchPublicationToken {
    return this.store.beginFetchPublication(trackingPrefix, candidateGlobalRefs);
  }

  publishFetchRefs(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return this.store.publishFetchRefs(token, plan, metadata);
  }

  activeRefLogOids(): Generator<string> {
    return this.store.activeRefLogOids();
  }

  // -- revisions ------------------------------------------------------

  /**
   * `gitrevisions(7)` subset: a ref, a full or abbreviated oid, and the
   * `^`, `^N` and `~N` suffixes, chained.
   */
  revParse(expression: string): string {
    if (expression.length > MAX_REVISION_EXPRESSION_UNITS) {
      throw new GitError("E2BIG", "revision expression exceeds 1024 UTF-16 code units");
    }
    const trimmed = expression.trim();
    if (trimmed === "") throw new RefNotFoundError(expression);

    // Split the base name from its suffix chain at the first ^ or ~ that
    // is not part of the name.
    let split = trimmed.length;
    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i]!;
      if (char === "^" || char === "~") {
        split = i;
        break;
      }
    }
    const base = trimmed.slice(0, split);
    const suffix = trimmed.slice(split);

    let oid = this.#resolveBase(base, expression);
    let position = 0;
    let traversals = 0;
    while (position < suffix.length) {
      const operator = suffix[position++]!;
      const digitsStart = position;
      while (position < suffix.length && suffix[position]! >= "0" && suffix[position]! <= "9") {
        position++;
      }
      const digits = suffix.slice(digitsStart, position);
      if (operator === "~") {
        const count = digits === "" ? 1 : boundedDecimal(digits, Number.MAX_SAFE_INTEGER);
        if (count === null || count > MAX_REVISION_TRAVERSALS - traversals) {
          throw new GitError("E2BIG", "revision expression exceeds 32 traversal operations");
        }
        traversals += count;
        for (let i = 0; i < count; i++) oid = this.#firstParent(oid, expression);
      } else if (operator === "^") {
        const which = digits === "" ? 1 : boundedDecimal(digits, Number.MAX_SAFE_INTEGER);
        if (which === null || traversals >= MAX_REVISION_TRAVERSALS) {
          throw new GitError("E2BIG", "revision expression exceeds 32 traversal operations");
        }
        traversals++;
        if (which === 0) {
          oid = this.peel(oid);
          continue;
        }
        oid = this.#parent(oid, which, expression);
      } else {
        throw new RefNotFoundError(expression);
      }
    }
    return oid;
  }

  #resolveBase(base: string, expression: string): string {
    if (base === "") throw new RefNotFoundError(base);
    const selectorStart = base.indexOf("@{");
    if (selectorStart !== -1) {
      if (!base.startsWith("HEAD@{") || !base.endsWith("}")) {
        throw new RefNotFoundError(expression);
      }
      const digits = base.slice(6, -1);
      const index = boundedDecimal(digits, MAX_HEAD_REFLOG_INDEX);
      if (index === null) throw new RefNotFoundError(expression);
      const entry = this.checkout.reflog("HEAD")[index];
      if (entry?.newOid === undefined || entry.newOid === null) {
        throw new RefNotFoundError(expression);
      }
      return entry.newOid;
    }
    const viaRef = this.resolveRef(base);
    if (viaRef !== null) return viaRef;
    if (isOid(base) && this.store.has(base)) return base;
    if (isAbbreviatedOid(base)) {
      const resolved = this.store.resolvePrefix(base);
      if (resolved !== null) return resolved;
    }
    throw new RefNotFoundError(base);
  }

  #firstParent(oid: string, expression: string): string {
    return this.#parent(oid, 1, expression);
  }

  #parent(oid: string, which: number, expression: string): string {
    const commit = this.readCommit(this.peel(oid));
    const parent = commit.parent[which - 1];
    if (parent === undefined) throw new RefNotFoundError(expression);
    return parent;
  }

  // -- walking --------------------------------------------------------

  /** Commits reachable from `oid`, first-parent-first, in commit-date order. */
  *walk(oid: string): Generator<{ oid: string; commit: Commit }> {
    const seen = new Set<string>();
    const queue = new CommitHeap();
    const fill = new CommitFillBuffer(this.store);
    let sequence = 0;
    let stateBytes = 0;
    const push = (candidate: string): void => {
      if (seen.has(candidate)) return;
      if (seen.size >= MAX_LOG_COMMITS) {
        throw new GitError("E2BIG", "commit graph exceeds the 50000 commit limit");
      }
      const entry = this.#readCommitEntry(candidate, fill);
      if (stateBytes + entry.cacheBytes > MAX_LOG_STATE_BYTES) {
        throw new GitError("E2BIG", "commit graph exceeds the 32 MiB retained-state limit");
      }
      stateBytes += entry.cacheBytes;
      seen.add(candidate);
      queue.push({ oid: candidate, commit: entry.commit, sequence: sequence++ });
    };

    try {
      push(this.peel(oid));
      const boundary = this.shallow();
      while (queue.size > 0) {
        const next = queue.pop()!;
        yield { oid: next.oid, commit: next.commit };
        if (boundary.has(next.oid)) continue;
        for (const parent of next.commit.parent) push(parent);
      }
    } finally {
      fill.flush();
    }
  }

  /** Fully validated indexed graph walk used by large and unbounded logs. */
  *walkIndexed(
    oid: string,
    limits: CommitGraphLimits = {},
  ): Generator<{ oid: string; commit: Commit }> {
    const root = this.peel(oid);
    const boundary = this.shallow();
    const entries = new Map<string, CommitCacheEntry>();
    let stateBytes = 0;
    const maxBytes = Math.min(limits.maxBytes ?? MAX_LOG_STATE_BYTES, MAX_LOG_STATE_BYTES);
    const maxCommits = Math.min(limits.maxCommits ?? MAX_LOG_COMMITS, MAX_LOG_COMMITS);
    for (const entry of this.store.commitGraph(root, limits)) {
      if (entries.has(entry.oid)) throw new CorruptError("commit graph yielded a duplicate oid");
      if (entries.size >= maxCommits) {
        throw new GitError("E2BIG", "commit graph exceeds the 50000 commit limit");
      }
      if (stateBytes + entry.cacheBytes > maxBytes) {
        throw new GitError("E2BIG", "commit graph exceeds the 32 MiB retained-state limit");
      }
      stateBytes += entry.cacheBytes;
      entries.set(entry.oid, entry);
    }
    if (!entries.has(root)) {
      throw new GitError(
        "E2BIG",
        "commit graph cache is incomplete; reindex or reclone the repository",
      );
    }
    this.#validateCommitGraph(root, entries, boundary, true);

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
      const next = queue.pop()!;
      yield { oid: next.oid, commit: next.commit };
      if (boundary.has(next.oid)) continue;
      for (const parent of next.commit.parent) push(parent);
    }
  }

  /** Validate only edges present in a bounded point walk; the depth frontier is intentional. */
  validateCommitWalk(entries: readonly { oid: string; commit: Commit }[]): void {
    const indexed = new Map<string, { commit: Commit }>();
    for (const entry of entries) {
      if (indexed.has(entry.oid)) throw new CorruptError("commit walk yielded a duplicate oid");
      indexed.set(entry.oid, { commit: entry.commit });
    }
    const root = entries[0]?.oid;
    if (root === undefined) return;
    this.#validateCommitGraph(root, indexed, this.shallow(), false);
  }

  #validateCommitGraph(
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

  /** The entry at `path` inside a tree, or null. */
  resolveTreePath(treeOid: string, path: string): TreeEntry | null {
    const segments = path.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) return { mode: "40000", name: "", oid: treeOid };
    let current = treeOid;
    for (let i = 0; i < segments.length; i++) {
      const entries = this.readTree(current);
      const match = entries.find((entry) => entry.name === segments[i]);
      if (match === undefined) return null;
      if (i === segments.length - 1) return match;
      if (!isTreeMode(match.mode)) return null;
      current = match.oid;
    }
    return null;
  }

  /** Every blob and submodule entry under a tree, as repo-relative paths. */
  *walkTree(treeOid: string, prefix = ""): Generator<{ path: string; entry: TreeEntry }> {
    const type = this.store.typeAndSize(treeOid)?.type;
    if (type === undefined) throw new ObjectNotFoundError(treeOid);
    const oid = type === "commit" ? parseCommit(this.read(treeOid).data).tree : treeOid;
    if (type !== "commit" && type !== "tree")
      throw new CorruptError(`${treeOid} is a ${type}, not a tree`);
    for (const entry of this.store.walkTree(oid)) {
      const path = prefix === "" ? entry.path : `${prefix}/${entry.path}`;
      const slash = entry.path.lastIndexOf("/");
      yield {
        path,
        entry: {
          mode: entry.mode,
          name: entry.path.slice(slash + 1),
          oid: entry.oid,
        },
      };
    }
  }

  /** Changed leaves between two tree objects, ordered by repo-relative path. */
  walkTreeDiff(
    beforeTreeOid: string | null,
    afterTreeOid: string | null,
  ): Generator<WalkTreeDiffEntry> {
    return this.store.walkTreeDiff(beforeTreeOid, afterTreeOid);
  }

  /** The tree of the commit HEAD points at, or null on an unborn branch. */
  headTree(): string | null {
    const { oid } = this.head();
    if (oid === null) return null;
    return this.readCommit(this.peel(oid)).tree;
  }
}
