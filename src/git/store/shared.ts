// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import type { SqlDatabase } from "../../db/db.js";
import { CorruptError, GitError } from "../common/errors.js";
import type { ByteLru } from "../common/lru.js";
import type { ObjectType, RawObject } from "../common/objects.js";
import { BlobIdTable } from "./blob-ids.js";
import {
  type CommitCacheEntry,
  type CommitCacheWriteResult,
  type CommitGraphLimits,
  indexCommitSource,
  insertCommitCaches,
  prepareCommitCache,
  readCommitCache,
  readCommitGraph,
} from "./commits.js";
import { ConfigTable } from "./config.js";
import type {
  BlobIdMapping,
  BlobReadBatch,
  BoundedSingleConfigValue,
  ConfigValueCardinality,
  FetchPublicationPlan,
  FetchPublicationToken,
  IndexStore,
  ObjectBatch,
  ObjectBatchOptions,
  ObjectReadBatch,
  ObjectReadInfo,
  OwnedObjectBatch,
  PromisedBlob,
  PromisorRemote,
  RefLogEntry,
  RefLogMetadata,
  RefLogReadOptions,
  RefMutation,
  RefRow,
  StoreOptions,
  TrackingRefPublicationToken,
} from "./contracts.js";
import { FetchPublicationTable } from "./fetch-publication.js";
import { ScratchIndexStore } from "./index-table.js";
import { isThenableResult, requireBooleanProbe } from "./json-pages.js";
import { advanceCheckoutRevision, requireScratchIndexName } from "./lifecycle.js";
import { bumpMaintenanceRootEpoch } from "./maintenance/control.js";
import { withGitMutationGuard } from "./mutation-guard.js";
import { ObjectTable } from "./objects.js";
import { PackStore } from "./packs.js";
import { PromisorTable } from "./promisor.js";
import { activeRefLogOids, type Clock, RefLogWriter, readRefLog } from "./reflog.js";
import { type HeadOwner, RefTable } from "./refs.js";
import { MAX_SCRATCH_INDEXES_PER_REPOSITORY } from "./schema.js";
import { ShallowTable } from "./shallow.js";
import {
  iterateTree,
  iterateTreeDiff,
  iterateTreeDiffObjects,
  type WalkTreeDiffEntry,
  type WalkTreeDiffObject,
  type WalkTreeEntry,
} from "./tree-walk.js";

interface ScratchStorageCache {
  revalidateStorageCaches(): void;
}

interface CheckoutOperations {
  readonly sharedRepoId: number;
  readonly checkoutId: number;
  readonly isPrimary: boolean;
  destroyOwned(): void;
}
interface SharedRepoStoreMutations {
  upsertBlobIdsOwned(mappings: Iterable<BlobIdMapping>): void;
  registerPromisorRemoteOwned(remoteName: string, url: string): PromisorRemote;
  addPromisedBlobsOwned(remoteName: string, oids: Iterable<string>): void;
  addPromisedBlobsFromPackTreesOwned(remoteName: string, packId: number): void;
  writeOwned(type: ObjectType, data: Uint8Array): string;
  writeStreamOwned(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string;
  writeBatchOwned(options?: ObjectBatchOptions): OwnedObjectBatch;
  objectTableOwned(): ObjectTable;
  withScratchIndexOwned<T>(name: string, body: (index: IndexStore) => T): T;
  setRefOwned(name: string, target: string): void;
  updateRefExpectedOwned(name: string, expectedOid: string, targetOid: string): void;
  deleteRefOwned(name: string): void;
  updateRefsOwned(puts: Iterable<RefRow>, deletes?: Iterable<string>): void;
  mutateSharedRefsOwned(mutation: RefMutation, metadata: RefLogMetadata): boolean;
  mutateRefsOwned(headOwner: HeadOwner, mutation: RefMutation, metadata: RefLogMetadata): boolean;
  publishTrackingRefOwned(
    token: TrackingRefPublicationToken,
    target: string | null,
    metadata: RefLogMetadata,
  ): boolean;
  publishFetchRefsOwned(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean;
  configSetOwned(path: string, value: string): void;
  configAddOwned(path: string, value: string): void;
  configUnsetOwned(path: string): void;
  configMoveSectionOwned(sourcePrefix: string, destinationPrefix: string): void;
  cacheCommitOwned(oid: string, data: Uint8Array): CommitCacheEntry | null;
  cacheCommitsOwned(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult;
  setShallowOwned(add: Iterable<string>, remove?: Iterable<string>): void;
  destroyOwned(): void;
}

const SHARED_REPO_STORE_MUTATIONS = new WeakMap<object, SharedRepoStoreMutations>();

/** Internal mutation capability; intentionally absent from the package facade. */
export function sharedRepoStoreMutations(store: SharedRepoStore): SharedRepoStoreMutations {
  const mutations = SHARED_REPO_STORE_MUTATIONS.get(store);
  if (mutations === undefined)
    throw new CorruptError("shared store mutation capability is missing");
  return mutations;
}

class ScratchTransactionCoordinator {
  #depth = 0;
  #failed = false;
  #failure: unknown;
  readonly #storageWrites = new Set<ScratchStorageCache>();

  get active(): boolean {
    return this.#depth > 0;
  }

  enter(): boolean {
    const outermost = this.#depth === 0;
    this.#depth++;
    return outermost;
  }

  fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#failure = error;
  }

  requireHealthy(): void {
    if (this.#failed) throw this.#failure;
  }

  markStorageWrite(store: ScratchStorageCache): void {
    if (this.#depth > 0) this.#storageWrites.add(store);
  }

  leave(): void {
    if (this.#depth < 1) throw new CorruptError("scratch transaction depth underflowed");
    this.#depth--;
  }

  finish(): { failed: boolean; failure: unknown; storageWrites: ScratchStorageCache[] } {
    if (this.#depth !== 0) throw new CorruptError("scratch transaction depth did not close");
    const result = {
      failed: this.#failed,
      failure: this.#failure,
      storageWrites: [...this.#storageWrites],
    };
    this.#failed = false;
    this.#failure = undefined;
    this.#storageWrites.clear();
    return result;
  }
}

const scratchTransactionsByDatabase = new WeakMap<SqlDatabase, ScratchTransactionCoordinator>();

function scratchTransactionsFor(db: SqlDatabase): ScratchTransactionCoordinator {
  const existing = scratchTransactionsByDatabase.get(db);
  if (existing !== undefined) return existing;
  const created = new ScratchTransactionCoordinator();
  scratchTransactionsByDatabase.set(db, created);
  return created;
}
/** Canonical resources shared by every checkout view of one Git store. */
export class SharedRepoStore {
  readonly db: SqlDatabase;
  readonly repoId: number;
  readonly objects: ByteLru<string, RawObject>;
  readonly packRows: ByteLru<string, Uint8Array>;
  readonly cacheNamespace: string;
  readonly #clock: Clock;
  readonly #config: ConfigTable;
  readonly #blobIds: BlobIdTable;
  readonly #shallowTable: ShallowTable;
  readonly #refs: RefTable;
  readonly #fetchPublication: FetchPublicationTable;
  readonly #promisor: PromisorTable;
  readonly #scratchTransactions: ScratchTransactionCoordinator;
  readonly #packs: PackStore;
  #objectTable: ObjectTable | null = null;
  #operations: CheckoutOperations | null = null;
  #headOwner: HeadOwner | null = null;
  #cacheGeneration = 0;
  #hasLoose: boolean;
  #shallow: Set<string> | null = null;

  constructor(
    db: SqlDatabase,
    repoId: number,
    storeGeneration: number,
    objects: ByteLru<string, RawObject>,
    packRows: ByteLru<string, Uint8Array>,
    clock: Clock,
    options: StoreOptions,
  ) {
    this.db = db;
    this.repoId = repoId;
    this.objects = objects;
    this.packRows = packRows;
    this.#clock = clock;
    this.#config = new ConfigTable(db, repoId);
    this.#blobIds = new BlobIdTable(db, repoId);
    this.#shallowTable = new ShallowTable(db, repoId);
    this.#refs = new RefTable(db, repoId, {
      revisions: {
        readRefMutationRevisionState: () => this.#fetchPublication.readRefMutationRevisionState(),
        bumpTrackingRefRevisions: (changedNames) =>
          this.#fetchPublication.bumpTrackingRefRevisions(changedNames),
        bumpFetchNamespaceRevisions: (changedNames) =>
          this.#fetchPublication.bumpFetchNamespaceRevisions(changedNames),
      },
      advanceCheckoutRevision: (expectedRevision) => {
        advanceCheckoutRevision(db, repoId, 1, expectedRevision);
      },
      bumpMaintenanceRootEpoch: () => {
        bumpMaintenanceRootEpoch(db, repoId);
      },
      reflogWriter: new RefLogWriter(db, repoId),
      clock,
    });
    this.#fetchPublication = new FetchPublicationTable(db, repoId, this.#refs, {
      headOwner: () => this.#heads(),
      invalidateShallow: () => this.invalidateShallow(),
      bumpMaintenanceRootEpoch: () => {
        bumpMaintenanceRootEpoch(db, repoId);
      },
    });
    this.#promisor = new PromisorTable(db, repoId);
    this.#scratchTransactions = scratchTransactionsFor(db);
    this.cacheNamespace = `${repoId}:${storeGeneration}`;
    this.#packs = new PackStore(
      db,
      repoId,
      objects,
      packRows,
      this.cacheNamespace,
      (oids: readonly string[]) => this.#objectOps().readLooseObjects(oids),
      (oids) => this.#objectOps().looseObjectMetadata(oids),
      options,
    );
    this.#objectTable = new ObjectTable(db, repoId, objects, this.#packs, this, clock);
    const availability = db.one<{ has_loose: unknown }>(
      `SELECT
         (SELECT COUNT(*) FROM (SELECT 1 FROM git_objects WHERE repo_id = ? LIMIT 1)) AS has_loose`,
      repoId,
    );
    if (
      availability === undefined ||
      (availability.has_loose !== 0 && availability.has_loose !== 1)
    ) {
      throw new CorruptError("shared store availability probe returned an invalid value");
    }
    this.#hasLoose = availability.has_loose === 1;
    SHARED_REPO_STORE_MUTATIONS.set(this, {
      upsertBlobIdsOwned: (mappings) => this.upsertBlobIdsOwned(mappings),
      registerPromisorRemoteOwned: (remoteName, url) =>
        this.registerPromisorRemoteOwned(remoteName, url),
      addPromisedBlobsOwned: (remoteName, oids) => this.addPromisedBlobsOwned(remoteName, oids),
      addPromisedBlobsFromPackTreesOwned: (remoteName, packId) =>
        this.addPromisedBlobsFromPackTreesOwned(remoteName, packId),
      writeOwned: (type, data) => this.writeOwned(type, data),
      writeStreamOwned: (type, size, chunks) => this.writeStreamOwned(type, size, chunks),
      writeBatchOwned: (batchOptions) => this.writeBatchOwned(batchOptions),
      objectTableOwned: () => this.#objectOps(),
      withScratchIndexOwned: (name, body) => this.withScratchIndexOwned(name, body),
      setRefOwned: (name, target) => this.setRefOwned(name, target),
      updateRefExpectedOwned: (name, expectedOid, targetOid) =>
        this.updateRefExpectedOwned(name, expectedOid, targetOid),
      deleteRefOwned: (name) => this.deleteRefOwned(name),
      updateRefsOwned: (puts, deletes) => this.updateRefsOwned(puts, deletes),
      mutateSharedRefsOwned: (mutation, metadata) => this.mutateSharedRefsOwned(mutation, metadata),
      mutateRefsOwned: (headOwner, mutation, metadata) =>
        this.mutateRefsOwned(headOwner, mutation, metadata),
      publishTrackingRefOwned: (token, target, metadata) =>
        this.publishTrackingRefOwned(token, target, metadata),
      publishFetchRefsOwned: (token, plan, metadata) =>
        this.publishFetchRefsOwned(token, plan, metadata),
      configSetOwned: (path, value) => this.configSetOwned(path, value),
      configAddOwned: (path, value) => this.configAddOwned(path, value),
      configUnsetOwned: (path) => this.configUnsetOwned(path),
      configMoveSectionOwned: (sourcePrefix, destinationPrefix) =>
        this.configMoveSectionOwned(sourcePrefix, destinationPrefix),
      cacheCommitOwned: (oid, data) => this.cacheCommitOwned(oid, data),
      cacheCommitsOwned: (entries) => this.cacheCommitsOwned(entries),
      setShallowOwned: (add, remove) => this.setShallowOwned(add, remove),
      destroyOwned: () => this.destroyOwned(),
    });
  }

  bindCheckoutOperations(operations: CheckoutOperations, headOwner: HeadOwner): void {
    if (operations.sharedRepoId !== this.repoId) {
      throw new CorruptError("shared operations facade belongs to another repository");
    }
    if (headOwner.checkoutId !== operations.checkoutId) {
      throw new CorruptError("shared HEAD owner belongs to another checkout");
    }
    if (this.#operations === null) {
      if (!operations.isPrimary) {
        throw new CorruptError("shared operations facade must use the primary checkout");
      }
      this.#operations = operations;
      this.#headOwner = headOwner;
    }
  }

  /** Poison an owning scratch transaction when a nested operation fails. */
  runScratchAwareOperation<T>(body: () => T): T {
    this.#scratchTransactions.requireHealthy();
    try {
      return body();
    } catch (error) {
      if (this.#scratchTransactions.active) this.#scratchTransactions.fail(error);
      throw error;
    }
  }

  /** Run one named scratch index as an isolated public Git mutation. */
  withScratchIndex<T>(name: string, body: (index: IndexStore) => T): T {
    return withGitMutationGuard(this.db, () => this.withScratchIndexOwned(name, body));
  }

  /** Run one named scratch index while the caller owns the mutation guard. */
  private withScratchIndexOwned<T>(name: string, body: (index: IndexStore) => T): T {
    const checkedName = requireScratchIndexName(name);
    const outermost = this.#scratchTransactions.enter();
    let opened = false;
    try {
      const result = this.db.transactionSync(() => {
        this.#scratchTransactions.requireHealthy();
        const existing = requireBooleanProbe(
          this.db.scalar<unknown>(
            `SELECT EXISTS(
               SELECT 1 FROM git_scratch_indexes WHERE repo_id = ? AND name = ? LIMIT 1
             )`,
            this.repoId,
            checkedName,
          ),
          "scratch index existence probe",
        );
        if (existing) {
          throw new GitError("EEXIST", `scratch index ${checkedName} is already active`);
        }
        const storedCount = this.db.scalar<unknown>(
          `SELECT count(*) FROM (
             SELECT 1 FROM git_scratch_indexes WHERE repo_id = ?
             LIMIT ${MAX_SCRATCH_INDEXES_PER_REPOSITORY + 1}
           )`,
          this.repoId,
        );
        if (
          typeof storedCount !== "number" ||
          !Number.isSafeInteger(storedCount) ||
          storedCount < 0 ||
          storedCount > MAX_SCRATCH_INDEXES_PER_REPOSITORY
        ) {
          throw new CorruptError("scratch index count is invalid");
        }
        if (storedCount >= MAX_SCRATCH_INDEXES_PER_REPOSITORY) {
          throw new GitError(
            "E2BIG",
            `repository already has ${MAX_SCRATCH_INDEXES_PER_REPOSITORY} active scratch indexes`,
          );
        }
        this.db.run(
          "INSERT INTO git_scratch_indexes (repo_id, name) VALUES (?, ?)",
          this.repoId,
          checkedName,
        );
        opened = true;
        const scratch = new ScratchIndexStore(this, checkedName);
        try {
          const result = body(scratch);
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "scratch index callback must be synchronous");
          }
          this.#scratchTransactions.requireHealthy();
          const deleted = this.db.one<Record<string, unknown>>(
            `DELETE FROM git_scratch_indexes WHERE repo_id = ? AND name = ?
             RETURNING repo_id, name`,
            this.repoId,
            checkedName,
          );
          if (deleted?.repo_id !== this.repoId || deleted.name !== checkedName) {
            throw new CorruptError("scratch index ownership changed before cleanup");
          }
          return result;
        } finally {
          scratch.revoke();
        }
      });
      this.#scratchTransactions.leave();
      if (outermost) this.#scratchTransactions.finish();
      return result;
    } catch (error) {
      if (opened) this.#scratchTransactions.fail(error);
      this.#scratchTransactions.leave();
      if (!outermost) throw error;
      const outcome = this.#scratchTransactions.finish();
      for (const store of outcome.storageWrites) store.revalidateStorageCaches();
      if (outcome.failed) throw outcome.failure;
      throw error;
    }
  }

  #ops(): CheckoutOperations {
    if (this.#operations === null) {
      throw new CorruptError("shared repository operations facade is unavailable");
    }
    return this.#operations;
  }

  #heads(): HeadOwner {
    if (this.#headOwner === null) {
      throw new CorruptError("shared repository HEAD owner is unavailable");
    }
    return this.#headOwner;
  }

  #objectOps(): ObjectTable {
    if (this.#objectTable === null) {
      throw new CorruptError("shared repository object table is unavailable");
    }
    return this.#objectTable;
  }

  get packs(): PackStore {
    return this.#packs;
  }

  get hasLoose(): boolean {
    return this.#hasLoose;
  }

  markLoose(): void {
    this.#scratchTransactions.markStorageWrite(this);
    this.#hasLoose = true;
  }

  objectCacheKey(oid: string): string {
    return `${this.cacheNamespace}:${this.#cacheGeneration}:loose:${oid}`;
  }

  clearCaches(): void {
    this.#cacheGeneration++;
    this.#packs.clearCaches();
    this.#hasLoose = true;
    this.#shallow = null;
  }

  /** Invalidate storage caches and re-read current loose-object availability. */
  revalidateStorageCaches(): void {
    this.#cacheGeneration++;
    this.#packs.clearCaches();
    this.#hasLoose = true;
    this.#shallow = null;
    let availability: boolean | undefined;
    let rows = 0;
    for (const row of this.db.iterate(
      `SELECT /* loose-storage-availability */
              COUNT(*) AS has_loose
         FROM (SELECT 1 FROM git_objects WHERE repo_id = ? LIMIT 1)`,
      this.repoId,
    )) {
      if ((row.has_loose !== 0 && row.has_loose !== 1) || rows !== 0) {
        throw new CorruptError("loose object availability probe returned an invalid value");
      }
      availability = row.has_loose === 1;
      rows++;
    }
    if (rows !== 1 || availability === undefined) {
      throw new CorruptError("loose object availability probe returned an invalid value");
    }
    this.#hasLoose = availability;
  }

  cacheBytes(): { objects: number; chunks: number } {
    return { objects: this.objects.bytes, chunks: this.#packs.cachedChunkBytes };
  }

  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    return this.#blobIds.lookup(contentIds);
  }

  blobIdMismatches(expected: Iterable<BlobIdMapping>): Map<number, string | null> {
    return this.#blobIds.mismatches(expected);
  }

  upsertBlobIds(mappings: Iterable<BlobIdMapping>): void {
    withGitMutationGuard(this.db, () => this.upsertBlobIdsOwned(mappings));
  }

  private upsertBlobIdsOwned(mappings: Iterable<BlobIdMapping>): void {
    this.#blobIds.upsert(mappings);
  }

  has(oid: string): boolean {
    return this.#objectOps().has(oid);
  }

  hasAll(oids: Iterable<string>): Set<string> {
    return this.#objectOps().hasAll(oids);
  }

  missing(oids: Iterable<string>): string[] {
    return this.#objectOps().missing(oids);
  }

  registerPromisorRemote(remoteName: string, url: string): PromisorRemote {
    return withGitMutationGuard(this.db, () => this.registerPromisorRemoteOwned(remoteName, url));
  }

  private registerPromisorRemoteOwned(remoteName: string, url: string): PromisorRemote {
    return this.#promisor.register(remoteName, url);
  }

  readPromisorRemote(remoteName: string): PromisorRemote | null {
    return this.#promisor.read(remoteName);
  }

  addPromisedBlobs(remoteName: string, oids: Iterable<string>): void {
    withGitMutationGuard(this.db, () => this.addPromisedBlobsOwned(remoteName, oids));
  }

  private addPromisedBlobsOwned(remoteName: string, oids: Iterable<string>): void {
    this.#promisor.addBlobs(remoteName, oids);
  }

  addPromisedBlobsFromPackTrees(remoteName: string, packId: number): void {
    withGitMutationGuard(this.db, () =>
      this.addPromisedBlobsFromPackTreesOwned(remoteName, packId),
    );
  }

  private addPromisedBlobsFromPackTreesOwned(remoteName: string, packId: number): void {
    this.#promisor.addBlobsFromPackTrees(remoteName, packId);
  }

  promisedMissing(oids: readonly string[]): string[] {
    return this.#promisor.promisedMissing(oids);
  }

  promisedMissingDetails(oids: readonly string[]): PromisedBlob[] {
    return this.#promisor.promisedMissingDetails(oids);
  }

  promisedBlobCount(): number {
    return this.#promisor.count();
  }

  *iteratePromisedBlobs(): Generator<PromisedBlob> {
    yield* this.#promisor.iterate();
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    return this.#objectOps().typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    return this.#objectOps().read(oid);
  }

  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    return this.#objectOps().readAuthenticatedObject(oid, expectedType);
  }

  readAuthenticatedObjectOwned(oid: string, expectedType: ObjectType): RawObject | null {
    return this.#objectOps().readAuthenticatedObjectOwned(oid, expectedType);
  }

  objectInfo(oids: readonly string[]): ObjectReadInfo[] {
    return this.#objectOps().objectInfo(oids);
  }

  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    return this.#objectOps().readObjects(oids, options);
  }

  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    return this.#objectOps().readBlobs(oids, options);
  }

  *walkTree(treeOid: string): Generator<WalkTreeEntry> {
    yield* iterateTree(this.db, this.repoId, treeOid);
  }

  *walkTreeDiff(
    beforeTreeOid: string | null,
    afterTreeOid: string | null,
  ): Generator<WalkTreeDiffEntry> {
    yield* iterateTreeDiff(this.db, this.repoId, beforeTreeOid, afterTreeOid);
  }

  *walkTreeDiffObjects(
    beforeTreeOid: string | null,
    afterTreeOid: string,
  ): Generator<WalkTreeDiffObject> {
    yield* iterateTreeDiffObjects(this.db, this.repoId, beforeTreeOid, afterTreeOid);
  }

  write(type: ObjectType, data: Uint8Array): string {
    return withGitMutationGuard(this.db, () => this.writeOwned(type, data));
  }

  private writeOwned(type: ObjectType, data: Uint8Array): string {
    return this.#objectOps().write(type, data);
  }

  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    return withGitMutationGuard(this.db, () => this.writeStreamOwned(type, size, chunks));
  }

  private writeStreamOwned(
    type: ObjectType,
    size: number,
    chunks: () => Iterable<Uint8Array>,
  ): string {
    return this.#objectOps().writeStream(type, size, chunks);
  }

  writeBatch(options: ObjectBatchOptions = {}): ObjectBatch {
    return this.#objectOps().writeBatchGuarded(options, (body) =>
      withGitMutationGuard(this.db, body),
    );
  }

  private writeBatchOwned(options: ObjectBatchOptions = {}): OwnedObjectBatch {
    return this.#objectOps().writeBatchOwned(options);
  }

  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    return withGitMutationGuard(this.db, () => this.#objectOps().writeObjects(body, options));
  }

  readChunks(oid: string): Iterable<Uint8Array> | null {
    return this.#objectOps().readChunks(oid);
  }

  resolvePrefix(prefix: string): string | null {
    return this.#objectOps().resolvePrefix(prefix);
  }

  objectCount(): number {
    return this.#objectOps().objectCount();
  }

  getRef(name: string): string | null {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return this.#refs.getRef(name);
  }

  setRef(name: string, target: string): void {
    withGitMutationGuard(this.db, () => this.setRefOwned(name, target));
  }

  private setRefOwned(name: string, target: string): void {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    this.#refs.setRef(this.#heads(), name, target);
  }

  updateRefExpected(name: string, expectedOid: string, targetOid: string): void {
    withGitMutationGuard(this.db, () => this.updateRefExpectedOwned(name, expectedOid, targetOid));
  }

  private updateRefExpectedOwned(name: string, expectedOid: string, targetOid: string): void {
    this.#refs.updateRefExpected(this.#heads(), name, expectedOid, targetOid);
  }

  deleteRef(name: string): void {
    withGitMutationGuard(this.db, () => this.deleteRefOwned(name));
  }

  private deleteRefOwned(name: string): void {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    this.#refs.deleteRef(this.#heads(), name);
  }

  updateRefs(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    withGitMutationGuard(this.db, () => this.updateRefsOwned(puts, deletes));
  }

  private updateRefsOwned(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    this.#refs.updateRefs(this.#heads(), puts, deletes);
  }

  mutateRefs(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    return withGitMutationGuard(this.db, () => this.mutateSharedRefsOwned(mutation, metadata));
  }

  private mutateSharedRefsOwned(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    if (mutation.head !== undefined) throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return this.#refs.mutateRefs(this.#heads(), mutation, metadata);
  }

  private mutateRefsOwned(
    headOwner: HeadOwner,
    mutation: RefMutation,
    metadata: RefLogMetadata,
  ): boolean {
    return this.#refs.mutateRefs(headOwner, mutation, metadata);
  }

  beginTrackingRefPublication(
    trackingPrefix: string,
    refName: string,
  ): TrackingRefPublicationToken {
    return this.#fetchPublication.beginTrackingRefPublication(trackingPrefix, refName);
  }

  publishTrackingRef(
    token: TrackingRefPublicationToken,
    target: string | null,
    metadata: RefLogMetadata,
  ): boolean {
    return withGitMutationGuard(this.db, () =>
      this.publishTrackingRefOwned(token, target, metadata),
    );
  }

  private publishTrackingRefOwned(
    token: TrackingRefPublicationToken,
    target: string | null,
    metadata: RefLogMetadata,
  ): boolean {
    return this.#fetchPublication.publishTrackingRef(token, target, metadata);
  }

  beginFetchPublication(
    trackingPrefix: string,
    candidateExactRefs: Iterable<string> = [],
  ): FetchPublicationToken {
    return this.#fetchPublication.beginFetchPublication(trackingPrefix, candidateExactRefs);
  }

  publishFetchRefs(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return withGitMutationGuard(this.db, () => this.publishFetchRefsOwned(token, plan, metadata));
  }

  private publishFetchRefsOwned(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return this.#fetchPublication.publishFetchRefs(token, plan, metadata);
  }

  listRefs(prefix = ""): RefRow[] {
    return this.#refs.listRefs(prefix);
  }

  /** Stream one validated, repository-scoped raw-ref snapshot in Git byte order. */
  *iterateRefs(): Generator<RefRow> {
    yield* this.#refs.iterateRefs();
  }

  reflog(refName: string, options: RefLogReadOptions = {}): RefLogEntry[] {
    if (refName === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return readRefLog(this.db, this.repoId, this.#ops().checkoutId, this.#clock, refName, options);
  }

  activeRefLogOids(): Generator<string> {
    return activeRefLogOids(this.db, this.repoId, this.#ops().checkoutId, this.#clock);
  }

  configGetAll(path: string): string[] {
    return this.#config.getAll(path);
  }

  configGet(path: string): string | undefined {
    return this.#config.get(path);
  }

  configGetOwned(path: string): string | undefined {
    return this.#config.getOwned(path);
  }

  configGetBounded(path: string, maxBytes?: number): string | undefined {
    return this.#config.getBounded(path, maxBytes);
  }

  configGetSingleBounded(path: string, maxBytes?: number): BoundedSingleConfigValue {
    return this.#config.getSingleBounded(path, maxBytes);
  }

  configCardinality(path: string): ConfigValueCardinality {
    return this.#config.cardinality(path);
  }

  configSet(path: string, value: string): void {
    withGitMutationGuard(this.db, () => this.configSetOwned(path, value));
  }

  private configSetOwned(path: string, value: string): void {
    this.#config.set(path, value);
  }

  configAdd(path: string, value: string): void {
    withGitMutationGuard(this.db, () => this.configAddOwned(path, value));
  }

  private configAddOwned(path: string, value: string): void {
    this.#config.add(path, value);
  }

  configUnset(path: string): void {
    withGitMutationGuard(this.db, () => this.configUnsetOwned(path));
  }

  private configUnsetOwned(path: string): void {
    this.#config.unset(path);
  }

  configPaths(prefix: string): string[] {
    return this.#config.paths(prefix);
  }

  configMoveSection(sourcePrefix: string, destinationPrefix: string): void {
    withGitMutationGuard(this.db, () =>
      this.configMoveSectionOwned(sourcePrefix, destinationPrefix),
    );
  }

  private configMoveSectionOwned(sourcePrefix: string, destinationPrefix: string): void {
    this.#config.moveSection(sourcePrefix, destinationPrefix);
  }

  cachedCommit(oid: string): CommitCacheEntry | null {
    return readCommitCache(this.db, this.repoId, oid);
  }

  prepareCommit(oid: string, data: Uint8Array): CommitCacheEntry {
    return prepareCommitCache({ repoId: this.repoId, oid, data });
  }

  cacheCommit(oid: string, data: Uint8Array): CommitCacheEntry | null {
    return withGitMutationGuard(this.db, () => this.cacheCommitOwned(oid, data));
  }

  private cacheCommitOwned(oid: string, data: Uint8Array): CommitCacheEntry | null {
    return indexCommitSource(this.db, { repoId: this.repoId, oid, data });
  }

  cacheCommits(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult {
    return withGitMutationGuard(this.db, () => this.cacheCommitsOwned(entries));
  }

  private cacheCommitsOwned(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult {
    return insertCommitCaches(this.db, entries);
  }

  commitGraph(rootOid: string, limits: CommitGraphLimits = {}): Iterable<CommitCacheEntry> {
    return readCommitGraph(this.db, this.repoId, rootOid, limits);
  }

  shallow(): Set<string> {
    if (this.#shallow === null) this.#shallow = this.#shallowTable.read();
    return new Set(this.#shallow);
  }

  readShallowOwned(): Set<string> {
    return this.#shallowTable.read();
  }

  invalidateShallow(): void {
    this.#shallow = null;
  }

  setShallow(add: Iterable<string>, remove: Iterable<string> = []): void {
    withGitMutationGuard(this.db, () => this.setShallowOwned(add, remove));
  }

  private setShallowOwned(add: Iterable<string>, remove: Iterable<string> = []): void {
    this.#shallowTable.set(add, remove);
    this.#shallow = null;
  }

  destroy(): void {
    withGitMutationGuard(this.db, () => this.destroyOwned());
  }

  private destroyOwned(): void {
    this.#ops().destroyOwned();
  }
}

/** Internal object-batch capability for composition under an existing mutation guard. */
export function writeBatchOwned(
  store: SharedRepoStore,
  options: ObjectBatchOptions = {},
): OwnedObjectBatch {
  return sharedRepoStoreMutations(store).writeBatchOwned(options);
}

/** Internal scoped object writer for composition under an existing mutation guard. */
export function writeObjectsOwned<T>(
  store: SharedRepoStore,
  body: (batch: ObjectBatch) => T,
  options: ObjectBatchOptions = {},
): T {
  const batch = writeBatchOwned(store, options);
  try {
    const result = body(batch);
    if (isThenableResult(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new GitError("EINVAL", "object batch callback must be synchronous");
    }
    batch.flush();
    return result;
  } finally {
    batch.dispose();
  }
}
