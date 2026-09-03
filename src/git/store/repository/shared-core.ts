import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError } from "../../common/errors.js";
import type { ByteLru } from "../../common/lru.js";
import type { ObjectType, RawObject } from "../../common/objects.js";
import type { StoreOptions } from "../core/contracts.js";
import { withGitMutationGuard } from "../core/mutation-guard.js";
import { advanceCheckoutRevision } from "../database/lifecycle.js";
import { FetchPublicationTable } from "../fetch/fetch-publication.js";
import { PromisorTable } from "../fetch/promisor.js";
import { bumpMaintenanceRootEpoch } from "../maintenance/control.js";
import { BlobIdTable } from "../objects/blob-ids.js";
import { ObjectTable } from "../objects/objects.js";
import { PackStore } from "../pack/packs.js";
import { ConfigTable } from "../refs/config.js";
import { type Clock, RefLogWriter } from "../refs/reflog.js";
import { type HeadOwner, RefTable } from "../refs/refs.js";
import { ShallowTable } from "../refs/shallow.js";
import {
  type CheckoutOperations,
  type ScratchTransactionCoordinator,
  scratchTransactionsFor,
} from "./shared-support.js";

/** Shared repository construction, ownership binding, and storage caches. */
export abstract class SharedRepoCore {
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
      headOwner: () => this.requireHeads(),
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
      (oids: readonly string[]) => this.requireObjectTable().readLooseObjects(oids),
      (oids) => this.requireObjectTable().looseObjectMetadata(oids),
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
  }

  abstract readAuthenticatedObjectOwned(oid: string, expectedType: ObjectType): RawObject | null;

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

  protected requireOperations(): CheckoutOperations {
    if (this.#operations === null) {
      throw new CorruptError("shared repository operations facade is unavailable");
    }
    return this.#operations;
  }

  protected requireHeads(): HeadOwner {
    if (this.#headOwner === null) {
      throw new CorruptError("shared repository HEAD owner is unavailable");
    }
    return this.#headOwner;
  }

  protected requireObjectTable(): ObjectTable {
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

  invalidateShallow(): void {
    this.#shallow = null;
  }

  shallow(): Set<string> {
    if (this.#shallow === null) this.#shallow = this.#shallowTable.read();
    return new Set(this.#shallow);
  }

  readShallowOwned(): Set<string> {
    return this.#shallowTable.read();
  }

  setShallow(add: Iterable<string>, remove: Iterable<string> = []): void {
    withGitMutationGuard(this.db, () => this.setShallowOwned(add, remove));
  }

  protected setShallowOwned(add: Iterable<string>, remove: Iterable<string> = []): void {
    this.#shallowTable.set(add, remove);
    this.#shallow = null;
  }

  protected refLogClock(): Clock {
    return this.#clock;
  }

  protected configTable(): ConfigTable {
    return this.#config;
  }

  protected blobIdTable(): BlobIdTable {
    return this.#blobIds;
  }

  protected refTable(): RefTable {
    return this.#refs;
  }

  protected fetchPublicationTable(): FetchPublicationTable {
    return this.#fetchPublication;
  }

  protected promisorTable(): PromisorTable {
    return this.#promisor;
  }

  protected scratchTransactionCoordinator(): ScratchTransactionCoordinator {
    return this.#scratchTransactions;
  }
}
