import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import type {
  BlobIdMapping,
  FetchPublicationPlan,
  FetchPublicationToken,
  IndexStore,
  ObjectBatchOptions,
  OwnedObjectBatch,
  PromisorRemote,
  RefLogMetadata,
  RefMutation,
  RefRow,
  TrackingRefPublicationToken,
} from "../core/contracts.js";
import type { ObjectTable } from "../objects/objects.js";
import type { HeadOwner } from "../refs/refs.js";
import type { CommitCacheEntry, CommitCacheWriteResult } from "../trees/commits.js";

export interface ScratchStorageCache {
  revalidateStorageCaches(): void;
}

export interface CheckoutOperations {
  readonly sharedRepoId: number;
  readonly checkoutId: number;
  readonly isPrimary: boolean;
  destroyOwned(): void;
}

export interface SharedRepoStoreMutations {
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

export function registerSharedRepoStoreMutations(
  store: object,
  mutations: SharedRepoStoreMutations,
): void {
  SHARED_REPO_STORE_MUTATIONS.set(store, mutations);
}

export function getSharedRepoStoreMutations(store: object): SharedRepoStoreMutations {
  const mutations = SHARED_REPO_STORE_MUTATIONS.get(store);
  if (mutations === undefined) {
    throw new CorruptError("shared store mutation capability is missing");
  }
  return mutations;
}

export class ScratchTransactionCoordinator {
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

export function scratchTransactionsFor(db: SqlDatabase): ScratchTransactionCoordinator {
  const existing = scratchTransactionsByDatabase.get(db);
  if (existing !== undefined) return existing;
  const created = new ScratchTransactionCoordinator();
  scratchTransactionsByDatabase.set(db, created);
  return created;
}
