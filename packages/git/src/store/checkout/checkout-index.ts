import type { SqlDatabase } from "@kompjutr/sqlite";
import type {
  IndexApplyOptions,
  IndexEntry,
  IndexScanOptions,
  IndexSink,
  InitialStateResult,
  InitialStateSession,
} from "../core/contracts.js";
import { IndexTable } from "../indexes/index-table.js";
import {
  type CommitCacheEntry,
  type CommitCacheWriteResult,
  type CommitGraphLimits,
  indexCommitSource,
  insertCommitCaches,
  prepareCommitCache,
  readCommitCache,
  readCommitGraph,
} from "../trees/commits.js";

export class CheckoutIndexStore {
  readonly #database: SqlDatabase;
  readonly #repoId: number;
  readonly #table: IndexTable;
  readonly #requireActive: () => void;

  constructor(
    database: SqlDatabase,
    repoId: number,
    checkoutId: number,
    requireActive: () => void,
  ) {
    this.#database = database;
    this.#repoId = repoId;
    this.#requireActive = requireActive;
    this.#table = new IndexTable(database, { kind: "checkout", repoId, checkoutId }, requireActive);
  }

  #db(): SqlDatabase {
    this.#requireActive();
    return this.#database;
  }

  tryCreateInitialStateOwned<T>(body: (session: InitialStateSession) => T): InitialStateResult<T> {
    return this.#table.tryCreateInitialState(body);
  }

  indexEntries(): IndexEntry[] {
    return this.#table.indexEntries();
  }

  indexGet(path: string, stage = 0): IndexEntry | null {
    return this.#table.indexGet(path, stage);
  }

  indexPutOwned(entry: IndexEntry): void {
    this.#table.indexPut(entry);
  }

  indexRemoveOwned(path: string): void {
    this.#table.indexRemove(path);
  }

  indexClearOwned(): void {
    this.#table.indexClear();
  }

  indexReplaceOwned(entries: Iterable<IndexEntry>, options: IndexApplyOptions = {}): void {
    this.#table.indexReplace(entries, options);
  }

  *indexScan(options: IndexScanOptions = {}): Generator<IndexEntry> {
    yield* this.#table.indexScan(options);
  }

  indexApplyOwned<T>(body: (sink: IndexSink) => T, options: IndexApplyOptions = {}): T {
    return this.#table.indexApply(body, options);
  }

  hasConflicts(): boolean {
    return this.#table.hasConflicts();
  }

  hasCheckoutBlockingIndexEntries(): boolean {
    return this.#table.hasCheckoutBlockingIndexEntries();
  }

  cachedCommit(oid: string): CommitCacheEntry | null {
    return readCommitCache(this.#db(), this.#repoId, oid);
  }

  prepareCommit(oid: string, data: Uint8Array): CommitCacheEntry {
    return prepareCommitCache({ repoId: this.#repoId, oid, data });
  }

  cacheCommitOwned(oid: string, data: Uint8Array): CommitCacheEntry | null {
    return indexCommitSource(this.#db(), { repoId: this.#repoId, oid, data });
  }

  cacheCommitsOwned(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult {
    return insertCommitCaches(this.#db(), entries);
  }

  commitGraph(rootOid: string, limits: CommitGraphLimits = {}): Iterable<CommitCacheEntry> {
    return readCommitGraph(this.#db(), this.#repoId, rootOid, limits);
  }
}
