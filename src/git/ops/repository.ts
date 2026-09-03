import {
  CorruptError,
  GitError,
  ObjectNotFoundError,
  PromisedObjectError,
} from "../common/errors.js";
import {
  type Commit,
  type ObjectType,
  parseCommit,
  parseTag,
  parseTree,
  type RawObject,
  type Tag,
  type TreeEntry,
} from "../common/objects.js";
import { checkoutStoreMutations } from "../store/checkout.js";
import type { CommitGraphLimits } from "../store/commits.js";
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
} from "../store/index.js";
import { readShallowOwned } from "../store/index.js";
import { withGitMutationGuard } from "../store/mutation-guard.js";
import { sharedRepoStoreMutations } from "../store/shared.js";
import {
  expandRefOwned,
  type ResolvedHead,
  resolveHeadOwned,
  resolveRefOwned,
} from "./repository-refs.js";
import {
  type RevisionResolution,
  resolveRevision,
  resolveTreeRevision,
  tryResolveRevision,
} from "./repository-revisions.js";
import { resolveTreePath, walkTree } from "./repository-trees.js";
import {
  authenticateCommitGraphThroughBoundary,
  type PrunedCommitWalkDecision,
  readAuthenticatedCommitOwned,
  readCommitOwned,
  validateCommitWalk,
  walkOwned as walkGraphOwned,
  walkIndexedOwned as walkIndexedGraphOwned,
  walkPrunedOwned as walkPrunedGraphOwned,
} from "./repository-walk.js";

// The repository: everything reachable from the object store and the refs,
// with no knowledge of Computer, DOFS or HTTP.

export type { ResolvedHead } from "./repository-refs.js";
export {
  expandRefOwned,
  readRawRefOwned,
  resolveHeadOwned,
  resolveRefOwned,
  symbolicTargetOwned,
} from "./repository-refs.js";
export type { RevisionResolution } from "./repository-revisions.js";
export type { PrunedCommitWalkDecision } from "./repository-walk.js";

type OwnedWalk = (oid: string) => Iterable<{ oid: string; commit: Commit }>;

type OwnedIndexedWalk = (
  oid: string,
  limits?: CommitGraphLimits,
) => Iterable<{ oid: string; commit: Commit }>;

type OwnedPrunedWalk = (
  oid: string,
  select: (entry: { oid: string; commit: Commit }) => PrunedCommitWalkDecision,
) => Iterable<{ oid: string; commit: Commit; include: boolean }>;

const OWNED_INDEXED_WALKS = new WeakMap<Repository, OwnedIndexedWalk>();
const OWNED_PRUNED_WALKS = new WeakMap<Repository, OwnedPrunedWalk>();
const OWNED_WALKS = new WeakMap<Repository, OwnedWalk>();

interface RepositoryMutations {
  invalidateShallowOwned(): void;
  mutateRefsOwned(mutation: RefMutation, metadata: RefLogMetadata): boolean;
  publishFetchRefsOwned(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean;
}

const REPOSITORY_MUTATIONS = new WeakMap<object, RepositoryMutations>();

/** Internal mutation capability; intentionally absent from the package facade. */
export function repositoryMutations(repo: Repository): RepositoryMutations {
  const mutations = REPOSITORY_MUTATIONS.get(repo);
  if (mutations === undefined) {
    throw new GitError("EINVAL", "repository mutation capability is unavailable");
  }
  return mutations;
}

/** Internal point walk retained under an existing repository operation. */
export function walkOwned(
  repo: Repository,
  oid: string,
): Iterable<{ oid: string; commit: Commit }> {
  const walk = OWNED_WALKS.get(repo);
  if (walk === undefined) throw new GitError("EINVAL", "repository graph owner is unavailable");
  return walk(oid);
}

/** Internal graph walk retained under an existing repository operation. */
export function walkIndexedOwned(
  repo: Repository,
  oid: string,
  limits: CommitGraphLimits = {},
): Iterable<{ oid: string; commit: Commit }> {
  const walk = OWNED_INDEXED_WALKS.get(repo);
  if (walk === undefined) throw new GitError("EINVAL", "repository graph owner is unavailable");
  return walk(oid, limits);
}

/** Internal point walk whose caller selects the parent frontier after each commit. */
export function walkPrunedOwned(
  repo: Repository,
  oid: string,
  select: (entry: { oid: string; commit: Commit }) => PrunedCommitWalkDecision,
): Iterable<{ oid: string; commit: Commit; include: boolean }> {
  const walk = OWNED_PRUNED_WALKS.get(repo);
  if (walk === undefined) throw new GitError("EINVAL", "repository graph owner is unavailable");
  return walk(oid, select);
}

export class Repository {
  readonly store: SharedRepoStore;

  constructor(readonly checkout: CheckoutStore) {
    this.store = checkout.shared;
    OWNED_INDEXED_WALKS.set(this, (oid, limits) => walkIndexedGraphOwned(this, oid, limits));
    OWNED_PRUNED_WALKS.set(this, (oid, select) => walkPrunedGraphOwned(this, oid, select));
    OWNED_WALKS.set(this, (oid) => walkGraphOwned(this, oid));
    REPOSITORY_MUTATIONS.set(this, {
      invalidateShallowOwned: () => this.invalidateShallowOwned(),
      mutateRefsOwned: (mutation, metadata) => this.mutateRefsOwned(mutation, metadata),
      publishFetchRefsOwned: (token, plan, metadata) =>
        this.publishFetchRefsOwned(token, plan, metadata),
    });
  }

  get root(): string {
    return this.checkout.root;
  }

  /** Commits whose parents this repository deliberately does not have. */
  shallow(): Set<string> {
    return readShallowOwned(this.store);
  }

  invalidateShallow(): void {
    withGitMutationGuard(this.checkout.db, () => this.invalidateShallowOwned());
  }

  private invalidateShallowOwned(): void {
    this.store.invalidateShallow();
  }

  read(oid: string): RawObject {
    const object = this.store.read(oid);
    if (object === null) {
      if (this.store.promisedMissing([oid]).length > 0) throw new PromisedObjectError([oid]);
      throw new ObjectNotFoundError(oid);
    }
    return object;
  }

  has(oid: string): boolean {
    return this.store.has(oid);
  }

  typeOf(oid: string): ObjectType {
    const found = this.store.typeAndSize(oid);
    if (found === null) {
      if (this.store.promisedMissing([oid]).length > 0) throw new PromisedObjectError([oid]);
      throw new ObjectNotFoundError(oid);
    }
    return found.type;
  }

  readCommit(oid: string): Commit {
    return readCommitOwned(this.store, oid);
  }

  /** Read, hash, and parse a commit from its authoritative physical source. */
  readAuthenticatedCommit(oid: string): Commit {
    return this.readAuthenticatedCommitOwned(oid);
  }

  /** Authenticate and parse one exact commit. */
  readAuthenticatedCommitOwned(oid: string): Commit {
    return readAuthenticatedCommitOwned(this.store, oid);
  }

  /** Authenticate commit roots and every parent edge through an explicit boundary. */
  authenticateCommitGraphThroughBoundary(
    roots: Iterable<string>,
    boundary: ReadonlySet<string>,
  ): Set<string> {
    return authenticateCommitGraphThroughBoundary(this, roots, boundary);
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
    const promised = this.store.promisedMissing(oids);
    if (promised.length > 0) throw new PromisedObjectError(promised);
    return this.store.readBlobs(oids, options);
  }

  /** Read a bounded prefix of mixed objects without scalar lookups. */
  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    const promised = this.store.promisedMissing(oids);
    if (promised.length > 0) throw new PromisedObjectError(promised);
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

  /** The full name of the ref `name` denotes, or null. */
  expandRef(name: string): string | null {
    return expandRefOwned(this, name);
  }

  /** Resolve a ref name (following symrefs) to an oid, or null. */
  resolveRef(name: string): string | null {
    return resolveRefOwned(this, name);
  }

  head(): ResolvedHead {
    return resolveHeadOwned(this);
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
    return withGitMutationGuard(this.checkout.db, () => this.mutateRefsOwned(mutation, metadata));
  }

  private mutateRefsOwned(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    return checkoutStoreMutations(this.checkout).mutateRefsOwned(mutation, metadata);
  }

  beginFetchPublication(
    trackingPrefix: string,
    candidateExactRefs: Iterable<string> = [],
  ): FetchPublicationToken {
    return this.store.beginFetchPublication(trackingPrefix, candidateExactRefs);
  }

  publishFetchRefs(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return withGitMutationGuard(this.checkout.db, () =>
      this.publishFetchRefsOwned(token, plan, metadata),
    );
  }

  private publishFetchRefsOwned(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return sharedRepoStoreMutations(this.store).publishFetchRefsOwned(token, plan, metadata);
  }

  activeRefLogOids(): Generator<string> {
    return this.store.activeRefLogOids();
  }

  resolveRevision(expression: string): RevisionResolution {
    return resolveRevision(this, expression);
  }

  revParse(expression: string): string {
    return this.resolveRevision(expression).oid;
  }

  tryRevParse(expression: string): string | undefined {
    return tryResolveRevision(this, expression)?.oid;
  }

  resolveTreeRevision(expression: string): string {
    return resolveTreeRevision(this, expression);
  }

  *walk(oid: string): Generator<{ oid: string; commit: Commit }> {
    yield* walkGraphOwned(this, oid);
  }

  *walkIndexed(
    oid: string,
    limits: CommitGraphLimits = {},
  ): Generator<{ oid: string; commit: Commit }> {
    yield* walkIndexedGraphOwned(this, oid, limits);
  }

  validateCommitWalk(entries: readonly { oid: string; commit: Commit }[]): void {
    validateCommitWalk(this, entries);
  }

  resolveTreePath(treeOid: string, path: string): TreeEntry | null {
    return resolveTreePath(this, treeOid, path);
  }

  *walkTree(treeOid: string, prefix = ""): Generator<{ path: string; entry: TreeEntry }> {
    yield* walkTree(this, treeOid, prefix);
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
    const { oid } = resolveHeadOwned(this);
    if (oid === null) return null;
    return this.readCommit(this.peel(oid)).tree;
  }
}
