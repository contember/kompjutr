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
  typeForMode,
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

export interface RevisionResolution {
  oid: string;
  /** Present only for `<revision>:<path>` resolution. */
  mode?: string;
}

interface RevisionState {
  oid: string;
  /** Stored metadata or a previously-read object promises this oid exists. */
  promised: boolean;
  /** A bare resolved ref or prefix must still authenticate its final oid. */
  verifyFinal?: boolean;
  /** Authenticated metadata retained when payload bytes are unnecessary. */
  type?: ObjectType;
  /** One authenticated current object avoids repeating a suffix read. */
  object?: RawObject;
}

interface RevisionStateResolution {
  state: RevisionState;
  mode?: string;
}

type RevisionSuffix =
  | { kind: "ancestor"; count: number }
  | { kind: "parent"; which: number }
  | { kind: "peel"; want: ObjectType | null };

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

  /** Resolve the bounded `gitrevisions(7)` subset and retain path mode. */
  resolveRevision(expression: string): RevisionResolution {
    const resolved = this.#tryResolveRevision(expression);
    if (resolved === undefined) throw new RefNotFoundError(expression);
    return resolved;
  }

  /** Resolve the bounded subset to an oid. */
  revParse(expression: string): string {
    return this.resolveRevision(expression).oid;
  }

  /** Return undefined only when a syntactically valid revision is absent. */
  tryRevParse(expression: string): string | undefined {
    return this.#tryResolveRevision(expression)?.oid;
  }

  #tryResolveRevision(expression: string): RevisionResolution | undefined {
    const resolved = this.#tryResolveRevisionState(expression);
    if (resolved === undefined) return undefined;
    return resolved.mode === undefined
      ? { oid: resolved.state.oid }
      : { oid: resolved.state.oid, mode: resolved.mode };
  }

  /** Resolve one tree-ish without repeating suffix authentication in its caller. */
  resolveTreeRevision(expression: string): string {
    const resolved = this.#tryResolveRevisionState(expression);
    if (resolved === undefined) throw new RefNotFoundError(expression);
    const state = resolved.state;
    let type =
      resolved.mode === undefined ? (state.object?.type ?? state.type) : typeForMode(resolved.mode);
    if (type === undefined) {
      const metadata = this.store.typeAndSize(state.oid);
      if (metadata === null) throw new ObjectNotFoundError(state.oid);
      type = metadata.type;
    }
    if (type === "tree") return state.oid;
    if (type === "commit") {
      return state.object === undefined
        ? this.readCommit(state.oid).tree
        : parseCommit(state.object.data).tree;
    }
    if (type === "tag") {
      const peeled = this.peel(state.oid, "commit");
      const peeledType = this.typeOf(peeled);
      if (peeledType === "tree") return peeled;
      if (peeledType === "commit") return this.readCommit(peeled).tree;
    }
    throw new ObjectNotFoundError(state.oid);
  }

  #tryResolveRevisionState(expression: string): RevisionStateResolution | undefined {
    if (expression.length > MAX_REVISION_EXPRESSION_UNITS) {
      throw new GitError("E2BIG", "revision expression exceeds 1024 UTF-16 code units");
    }
    const trimmed = expression.trim();
    if (trimmed === "") return undefined;

    const colon = trimmed.indexOf(":");
    const revision = colon === -1 ? trimmed : trimmed.slice(0, colon);
    const path = colon === -1 ? undefined : trimmed.slice(colon + 1);
    if (revision === "") throw this.#invalidRevision(expression);

    // Split the base name from its suffix chain at the first ^ or ~ that
    // is not part of the name.
    let split = revision.length;
    for (let i = 0; i < revision.length; i++) {
      const char = revision[i]!;
      if (char === "^" || char === "~") {
        split = i;
        break;
      }
    }
    const base = revision.slice(0, split);
    const suffix = revision.slice(split);
    const operations = this.#parseRevisionSuffix(suffix, expression);

    let state = this.#resolveRevisionBase(base, expression);
    if (state === undefined) return undefined;
    for (const operation of operations) {
      if (operation.kind === "peel") {
        state = this.#peelRevision(state, operation.want, expression);
        if (state === undefined) return undefined;
        continue;
      }
      if (operation.kind === "ancestor") {
        state = this.#peelRevision(state, "commit", expression);
        if (state === undefined) return undefined;
        for (let i = 0; i < operation.count; i++) {
          const parent = this.#revisionParent(state, 1, expression);
          if (parent === undefined) return undefined;
          state = parent;
        }
        continue;
      }
      if (operation.which === 0) {
        state = this.#peelRevision(state, "commit", expression);
        if (state === undefined) return undefined;
        continue;
      }
      const parent = this.#revisionParent(state, operation.which, expression);
      if (parent === undefined) return undefined;
      state = parent;
    }

    if (path !== undefined) return this.#resolveRevisionPath(state, path, expression);
    if (state.verifyFinal === true && state.object === undefined) {
      const metadata = this.store.typeAndSize(state.oid);
      if (metadata === null) throw new ObjectNotFoundError(state.oid);
      state = { ...state, type: metadata.type };
    }
    return { state };
  }

  #parseRevisionSuffix(suffix: string, expression: string): RevisionSuffix[] {
    const operations: RevisionSuffix[] = [];
    let position = 0;
    let traversals = 0;
    const reserve = (count: number): void => {
      if (count > MAX_REVISION_TRAVERSALS - traversals) {
        throw new GitError("E2BIG", "revision expression exceeds 32 traversal operations");
      }
      traversals += count;
    };
    while (position < suffix.length) {
      const operator = suffix[position++]!;
      if (operator !== "^" && operator !== "~") throw this.#invalidRevision(expression);
      if (operator === "^" && suffix[position] === "{") {
        const close = suffix.indexOf("}", position + 1);
        if (close === -1) throw this.#invalidRevision(expression);
        const type = suffix.slice(position + 1, close);
        if (
          type !== "" &&
          type !== "commit" &&
          type !== "tree" &&
          type !== "blob" &&
          type !== "tag"
        ) {
          throw this.#invalidRevision(expression);
        }
        reserve(1);
        operations.push({ kind: "peel", want: type === "" ? null : type });
        position = close + 1;
        continue;
      }
      const digitsStart = position;
      while (position < suffix.length && suffix[position]! >= "0" && suffix[position]! <= "9") {
        position++;
      }
      const digits = suffix.slice(digitsStart, position);
      const value = digits === "" ? 1 : boundedDecimal(digits, Number.MAX_SAFE_INTEGER);
      if (value === null) {
        throw new GitError("E2BIG", "revision expression exceeds 32 traversal operations");
      }
      if (operator === "~") {
        reserve(Math.max(1, value));
        operations.push({ kind: "ancestor", count: value });
      } else {
        reserve(1);
        operations.push({ kind: "parent", which: value });
      }
    }
    return operations;
  }

  #resolveRevisionBase(base: string, expression: string): RevisionState | undefined {
    if (base === "") throw this.#invalidRevision(expression);
    const selectorStart = base.indexOf("@{");
    if (selectorStart !== -1) {
      if (!base.startsWith("HEAD@{") || !base.endsWith("}")) {
        throw new RefNotFoundError(expression);
      }
      const digits = base.slice(6, -1);
      const index = boundedDecimal(digits, MAX_HEAD_REFLOG_INDEX);
      if (index === null) throw new RefNotFoundError(expression);
      const entry = this.checkout.reflog("HEAD")[index];
      if (entry?.newOid === undefined || entry.newOid === null) return undefined;
      return { oid: entry.newOid, promised: true };
    }
    const oid = this.resolveRef(base);
    if (oid !== null) return { oid, promised: true, verifyFinal: true };
    if (isOid(base)) return { oid: base, promised: false };
    if (isAbbreviatedOid(base)) {
      const resolved = this.store.resolvePrefix(base);
      if (resolved !== null) return { oid: resolved, promised: true, verifyFinal: true };
    }
    return undefined;
  }

  #revisionParent(
    state: RevisionState,
    which: number,
    expression: string,
  ): RevisionState | undefined {
    const commitState = this.#peelRevision(state, "commit", expression);
    if (commitState === undefined) return undefined;
    const object = this.#readRevisionObject(commitState);
    if (object === undefined) return undefined;
    if (object.type !== "commit") throw new CorruptError(`${commitState.oid} is not a commit`);
    const parent = parseCommit(object.data).parent[which - 1];
    if (parent === undefined) throw new RefNotFoundError(expression);
    const parentState: RevisionState = { oid: parent, promised: true };
    const parentObject = this.#readRevisionObject(parentState);
    if (parentObject === undefined) throw new ObjectNotFoundError(parent);
    if (parentObject.type !== "commit") {
      throw new CorruptError(`parent ${parent} is a ${parentObject.type}, not a commit`);
    }
    parseCommit(parentObject.data);
    return { ...parentState, object: parentObject };
  }

  #peelRevision(
    initial: RevisionState,
    want: ObjectType | null,
    expression: string,
  ): RevisionState | undefined {
    let state = initial;
    let expected: ObjectType | undefined;
    for (let hops = 0; hops < 16; hops++) {
      const object = this.#readRevisionObject(state);
      if (object === undefined) return undefined;
      if (expected !== undefined && object.type !== expected) {
        throw new CorruptError(`tag target ${state.oid} is a ${object.type}, not a ${expected}`);
      }
      this.#validateRevisionObject(object);
      if (want === null && object.type !== "tag") return { ...state, object };
      if (object.type === want) return { ...state, object };
      if (want === "tree" && object.type === "commit") {
        const tree = parseCommit(object.data).tree;
        const treeState: RevisionState = { oid: tree, promised: true };
        const treeObject = this.#readRevisionObject(treeState);
        if (treeObject === undefined) throw new ObjectNotFoundError(tree);
        if (treeObject.type !== "tree") {
          throw new CorruptError(`commit tree ${tree} is a ${treeObject.type}, not a tree`);
        }
        parseTree(treeObject.data);
        return { ...treeState, object: treeObject };
      }
      if (object.type !== "tag") throw new RefNotFoundError(expression);
      const tag = parseTag(object.data);
      expected = tag.type;
      state = { oid: tag.object, promised: true };
    }
    throw new CorruptError(`tag chain from ${initial.oid} is too deep`);
  }

  #resolveRevisionPath(
    state: RevisionState,
    path: string,
    expression: string,
  ): RevisionStateResolution | undefined {
    const treeState = this.#peelRevision(state, "tree", expression);
    if (treeState === undefined) return undefined;
    if (path === "") return { state: treeState, mode: "40000" };
    const entry = this.resolveTreePath(treeState.oid, path);
    if (entry === null) return undefined;
    const object = this.#readRevisionObject({ oid: entry.oid, promised: true });
    if (object === undefined) throw new ObjectNotFoundError(entry.oid);
    const expected = typeForMode(entry.mode);
    if (object.type !== expected) {
      throw new CorruptError(`tree entry ${entry.oid} is a ${object.type}, not a ${expected}`);
    }
    this.#validateRevisionObject(object);
    return {
      state: { oid: entry.oid, promised: true, object },
      mode: entry.mode,
    };
  }

  #readRevisionObject(state: RevisionState): RawObject | undefined {
    if (state.object !== undefined) return state.object;
    const object = this.store.read(state.oid);
    if (object !== null) return object;
    if (state.promised) throw new ObjectNotFoundError(state.oid);
    return undefined;
  }

  #validateRevisionObject(object: RawObject): void {
    if (object.type === "commit") parseCommit(object.data);
    else if (object.type === "tree") parseTree(object.data);
    else if (object.type === "tag") parseTag(object.data);
  }

  #invalidRevision(expression: string): GitError {
    return new GitError("EINVAL", `invalid revision expression: ${expression}`);
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
