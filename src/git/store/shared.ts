// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import type { SqlDatabase } from "../../db/db.js";
import { CorruptError, GitError } from "../common/errors.js";
import type { ByteLru } from "../common/lru.js";
import type { ObjectType, RawObject } from "../common/objects.js";
import {
  type CheckoutStore,
  isThenableResult,
  OWNED_AUTHENTICATED_OBJECT_READERS,
  OWNED_CONFIG_GETTERS,
  OWNED_OBJECT_BATCHES,
  requireBooleanProbe,
  requireScratchIndexName,
  ScratchIndexStore,
} from "./checkout.js";
import type { CommitCacheEntry, CommitCacheWriteResult, CommitGraphLimits } from "./commits.js";
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
  RefLogEntry,
  RefLogMetadata,
  RefLogReadOptions,
  RefMutation,
  RefRow,
  TrackingRefPublicationToken,
} from "./contracts.js";
import type { PackStore } from "./packs.js";
import { MAX_SCRATCH_INDEXES_PER_REPOSITORY } from "./schema.js";
import type { WalkTreeDiffEntry, WalkTreeDiffObject, WalkTreeEntry } from "./tree-walk.js";

export interface SharedRepoOwnedOperations {
  objectBatch(options: ObjectBatchOptions): OwnedObjectBatch;
  authenticatedObject(oid: string, expectedType: ObjectType): RawObject | null;
  configValue(path: string): string | undefined;
}

interface ScratchStorageCache {
  revalidateStorageCaches(): void;
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
  readonly #scratchTransactions: ScratchTransactionCoordinator;
  #packs: PackStore | null = null;
  #operations: CheckoutStore | null = null;
  #ownedOperations: SharedRepoOwnedOperations | null = null;
  #cacheGeneration = 0;
  #hasLoose: boolean;
  #shallow: Set<string> | null = null;

  constructor(
    db: SqlDatabase,
    repoId: number,
    storeGeneration: number,
    objects: ByteLru<string, RawObject>,
    packRows: ByteLru<string, Uint8Array>,
  ) {
    this.db = db;
    this.repoId = repoId;
    this.objects = objects;
    this.packRows = packRows;
    this.#scratchTransactions = scratchTransactionsFor(db);
    this.cacheNamespace = `${repoId}:${storeGeneration}`;
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
    OWNED_OBJECT_BATCHES.set(this, (options) => this.#ownedOps().objectBatch(options));
    OWNED_AUTHENTICATED_OBJECT_READERS.set(this, (oid, expectedType) =>
      this.#ownedOps().authenticatedObject(oid, expectedType),
    );
    OWNED_CONFIG_GETTERS.set(this, (path) => this.#ownedOps().configValue(path));
  }

  installPacks(packs: PackStore): PackStore {
    if (this.#packs === null) this.#packs = packs;
    return this.#packs;
  }

  installOperations(operations: CheckoutStore, ownedOperations: SharedRepoOwnedOperations): void {
    if (operations.sharedRepoId !== this.repoId) {
      throw new CorruptError("shared operations facade belongs to another repository");
    }
    if (this.#operations === null) {
      if (!operations.isPrimary) {
        throw new CorruptError("shared operations facade must use the primary checkout");
      }
      this.#operations = operations;
      this.#ownedOperations = ownedOperations;
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

  /** Run one named scratch index inside the caller's synchronous transaction. */
  withScratchIndex<T>(name: string, body: (index: IndexStore) => T): T {
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

  #ops(): CheckoutStore {
    if (this.#operations === null) {
      throw new CorruptError("shared repository operations facade is unavailable");
    }
    return this.#operations;
  }

  #ownedOps(): SharedRepoOwnedOperations {
    if (this.#ownedOperations === null) {
      throw new CorruptError("shared repository owned operations are unavailable");
    }
    return this.#ownedOperations;
  }

  get packs(): PackStore {
    if (this.#packs === null) {
      throw new CorruptError("shared pack facade is unavailable");
    }
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
    this.#packs?.clearCaches();
    this.#hasLoose = false;
    this.#shallow = null;
  }

  /** Invalidate storage caches and re-read current loose-object availability. */
  revalidateStorageCaches(): void {
    this.#cacheGeneration++;
    this.#packs?.clearCaches();
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
    return this.#ops().cacheBytes();
  }

  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    return this.#ops().lookupBlobIds(contentIds);
  }

  blobIdMismatches(expected: Iterable<BlobIdMapping>): Map<number, string | null> {
    return this.#ops().blobIdMismatches(expected);
  }

  upsertBlobIds(mappings: Iterable<BlobIdMapping>): void {
    this.#ops().upsertBlobIds(mappings);
  }

  has(oid: string): boolean {
    return this.#ops().has(oid);
  }

  hasAll(oids: Iterable<string>): Set<string> {
    return this.#ops().hasAll(oids);
  }

  missing(oids: Iterable<string>): string[] {
    return this.#ops().missing(oids);
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    return this.#ops().typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    return this.#ops().read(oid);
  }

  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    return this.#ops().readAuthenticatedObject(oid, expectedType);
  }

  objectInfo(oids: readonly string[]): ObjectReadInfo[] {
    return this.#ops().objectInfo(oids);
  }

  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    return this.#ops().readObjects(oids, options);
  }

  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    return this.#ops().readBlobs(oids, options);
  }

  *walkTree(treeOid: string): Generator<WalkTreeEntry> {
    yield* this.#ops().walkTree(treeOid);
  }

  *walkTreeDiff(
    beforeTreeOid: string | null,
    afterTreeOid: string | null,
  ): Generator<WalkTreeDiffEntry> {
    yield* this.#ops().walkTreeDiff(beforeTreeOid, afterTreeOid);
  }

  *walkTreeDiffObjects(
    beforeTreeOid: string | null,
    afterTreeOid: string,
  ): Generator<WalkTreeDiffObject> {
    yield* this.#ops().walkTreeDiffObjects(beforeTreeOid, afterTreeOid);
  }

  write(type: ObjectType, data: Uint8Array): string {
    return this.#ops().write(type, data);
  }

  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    return this.#ops().writeStream(type, size, chunks);
  }

  writeBatch(options: ObjectBatchOptions = {}): ObjectBatch {
    return this.#ops().writeBatch(options);
  }

  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    return this.#ops().writeObjects(body, options);
  }

  readChunks(oid: string): Iterable<Uint8Array> | null {
    return this.#ops().readChunks(oid);
  }

  resolvePrefix(prefix: string): string | null {
    return this.#ops().resolvePrefix(prefix);
  }

  objectCount(): number {
    return this.#ops().objectCount();
  }

  getRef(name: string): string | null {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return this.#ops().getRef(name);
  }

  setRef(name: string, target: string): void {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    this.#ops().setRef(name, target);
  }

  updateRefExpected(name: string, expectedOid: string, targetOid: string): void {
    this.#ops().updateRefExpected(name, expectedOid, targetOid);
  }

  deleteRef(name: string): void {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    this.#ops().deleteRef(name);
  }

  updateRefs(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    this.#ops().updateRefs(puts, deletes);
  }

  mutateRefs(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    if (mutation.head !== undefined) throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return this.#ops().mutateRefs(mutation, metadata);
  }

  beginTrackingRefPublication(
    trackingPrefix: string,
    refName: string,
  ): TrackingRefPublicationToken {
    return this.#ops().beginTrackingRefPublication(trackingPrefix, refName);
  }

  publishTrackingRef(
    token: TrackingRefPublicationToken,
    target: string | null,
    metadata: RefLogMetadata,
  ): boolean {
    return this.#ops().publishTrackingRef(token, target, metadata);
  }

  beginFetchPublication(
    trackingPrefix: string,
    candidateExactRefs: Iterable<string> = [],
  ): FetchPublicationToken {
    return this.#ops().beginFetchPublication(trackingPrefix, candidateExactRefs);
  }

  publishFetchRefs(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return this.#ops().publishFetchRefs(token, plan, metadata);
  }

  listRefs(prefix = ""): RefRow[] {
    return this.#ops().listRefs(prefix);
  }

  /** Stream one validated, repository-scoped raw-ref snapshot in Git byte order. */
  *iterateRefs(): Generator<RefRow> {
    yield* this.#ops().iterateRefs();
  }

  reflog(refName: string, options: RefLogReadOptions = {}): RefLogEntry[] {
    if (refName === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return this.#ops().reflog(refName, options);
  }

  activeRefLogOids(): Generator<string> {
    return this.#ops().activeRefLogOids();
  }

  configGetAll(path: string): string[] {
    return this.#ops().configGetAll(path);
  }

  configGet(path: string): string | undefined {
    return this.#ops().configGet(path);
  }

  configGetBounded(path: string, maxBytes?: number): string | undefined {
    return this.#ops().configGetBounded(path, maxBytes);
  }

  configGetSingleBounded(path: string, maxBytes?: number): BoundedSingleConfigValue {
    return this.#ops().configGetSingleBounded(path, maxBytes);
  }

  configCardinality(path: string): ConfigValueCardinality {
    return this.#ops().configCardinality(path);
  }

  configSet(path: string, value: string): void {
    this.#ops().configSet(path, value);
  }

  configAdd(path: string, value: string): void {
    this.#ops().configAdd(path, value);
  }

  configUnset(path: string): void {
    this.#ops().configUnset(path);
  }

  configPaths(prefix: string): string[] {
    return this.#ops().configPaths(prefix);
  }

  configMoveSection(sourcePrefix: string, destinationPrefix: string): void {
    this.#ops().configMoveSection(sourcePrefix, destinationPrefix);
  }

  cachedCommit(oid: string): CommitCacheEntry | null {
    return this.#ops().cachedCommit(oid);
  }

  prepareCommit(oid: string, data: Uint8Array): CommitCacheEntry {
    return this.#ops().prepareCommit(oid, data);
  }

  cacheCommit(oid: string, data: Uint8Array): CommitCacheEntry | null {
    return this.#ops().cacheCommit(oid, data);
  }

  cacheCommits(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult {
    return this.#ops().cacheCommits(entries);
  }

  commitGraph(rootOid: string, limits: CommitGraphLimits = {}): Iterable<CommitCacheEntry> {
    return this.#ops().commitGraph(rootOid, limits);
  }

  shallow(): Set<string> {
    if (this.#shallow === null) this.#shallow = this.#ops().shallow();
    return new Set(this.#shallow);
  }

  invalidateShallow(): void {
    this.#shallow = null;
  }

  setShallow(add: Iterable<string>, remove: Iterable<string> = []): void {
    this.#ops().setShallow(add, remove);
    this.#shallow = null;
  }

  destroy(): void {
    this.#ops().destroy();
  }
}
