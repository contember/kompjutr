import type { SqlDatabase } from "../../db/db.js";
import { CorruptError, GitError } from "../common/errors.js";
import type { ObjectType, RawObject } from "../common/objects.js";
import { expectText } from "../common/rows.js";
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
import type {
  BlobIdMapping,
  BlobReadBatch,
  BoundedSingleConfigValue,
  CheckoutRow,
  ConfigValueCardinality,
  FetchPublicationPlan,
  FetchPublicationToken,
  IndexApplyOptions,
  IndexEntry,
  IndexScanOptions,
  IndexSink,
  IndexStore,
  InitialStateResult,
  InitialStateSession,
  ObjectBatch,
  ObjectBatchOptions,
  ObjectReadBatch,
  ObjectReadInfo,
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
import { IndexTable } from "./index-table.js";
import { jsonPages } from "./json-pages.js";
import {
  CheckoutStoreLifetime,
  isAttachedBranchUniqueConstraint,
  requireSafeId,
  requireStoredCheckoutRow,
} from "./lifecycle.js";
import { OperationJournalTable } from "./operation-journal.js";
import type {
  CherryPickJournal,
  MergeJournal,
  MergeOperationJournal,
  MergeStateMetadata,
  MergeTouchedPath,
  OperationJournal,
  OperationKind,
  OperationStateMetadata,
  OperationStepMetadata,
  RebaseJournal,
  RevertJournal,
} from "./operations.js";
import type { PackStore } from "./packs.js";
import { rawSymbolicTarget, requireRefName } from "./ref-validation.js";
import {
  activeRefLogOids,
  type CheckoutRefLogEvent,
  REFLOG_RETENTION_ROWS,
  readRefLog,
} from "./reflog.js";
import type { HeadOwner } from "./refs.js";
import { MAX_CHECKOUTS_PER_REPOSITORY } from "./schema.js";
import type { SharedRepoStore } from "./shared.js";
import {
  iterateTree,
  iterateTreeDiff,
  iterateTreeDiffObjects,
  type WalkTreeDiffEntry,
  type WalkTreeDiffObject,
  type WalkTreeEntry,
} from "./tree-walk.js";

export const DEFAULT_OBJECT_CACHE_BYTES = 8 * 1024 * 1024;

/** Checkout-bound storage view. */
export class CheckoutStore implements IndexStore {
  readonly #sharedStore: SharedRepoStore;
  readonly #database: SqlDatabase;
  readonly #repoId: number;
  readonly #checkoutId: number;
  readonly #root: string;
  readonly #isPrimary: boolean;
  readonly #indexTable: IndexTable;
  readonly #operationJournals: OperationJournalTable;
  readonly #headOwner: HeadOwner;
  readonly #onDestroy: (() => void) | undefined;
  readonly #now: () => number;
  readonly #lifetime: CheckoutStoreLifetime;

  constructor(
    shared: SharedRepoStore,
    checkout: CheckoutRow,
    options: StoreOptions = {},
    onDestroy?: () => void,
    lifetime = new CheckoutStoreLifetime(),
  ) {
    if (
      requireSafeId(checkout.id, "checkout id") < 1 ||
      requireSafeId(checkout.repoId, "checkout repository id") !== shared.repoId
    ) {
      throw new CorruptError("checkout facade identity is invalid");
    }
    this.#sharedStore = shared;
    this.#onDestroy = onDestroy;
    this.#now = options.now ?? Date.now;
    this.#lifetime = lifetime;
    this.#database = shared.db;
    this.#repoId = shared.repoId;
    this.#checkoutId = checkout.id;
    this.#root = checkout.root;
    this.#isPrimary = checkout.isPrimary;
    this.#indexTable = new IndexTable(
      this.#database,
      { kind: "checkout", repoId: this.#repoId, checkoutId: this.#checkoutId },
      () => this.#requireActive(),
    );
    this.#operationJournals = new OperationJournalTable(
      this.#database,
      this.#repoId,
      this.#checkoutId,
      shared.objectTable,
    );
    this.#headOwner = {
      checkoutId: this.#checkoutId,
      readRefMutationHeads: () => this.#readRefMutationHeads(),
      findAttachedBranchOwner: (head) => this.#findAttachedBranchOwner(head),
      updateRefMutationHead: (expectedHead, newHead) =>
        this.#updateRefMutationHead(expectedHead, newHead),
      appendCheckoutRefLogs: (events) => this.#appendCheckoutRefLogs(events),
      pruneExpiredCheckoutRefLogs: (cutoff) => this.#pruneExpiredCheckoutRefLogs(cutoff),
      pruneRetainedCheckoutRefLogs: (events) => this.#pruneRetainedCheckoutRefLogs(events),
    };
    shared.bindCheckoutOperations(this, this.#headOwner);
  }

  #requireActive(): void {
    this.#lifetime.requireActive();
  }

  get shared(): SharedRepoStore {
    this.#requireActive();
    return this.#sharedStore;
  }

  get #db(): SqlDatabase {
    this.#requireActive();
    return this.#database;
  }

  get db(): SqlDatabase {
    return this.#db;
  }

  get repoId(): number {
    return this.#repoId;
  }

  get sharedRepoId(): number {
    return this.#repoId;
  }

  get checkoutId(): number {
    return this.#checkoutId;
  }

  get root(): string {
    return this.#root;
  }

  get isPrimary(): boolean {
    return this.#isPrimary;
  }

  get packs(): PackStore {
    return this.shared.packs;
  }

  /** Bytes currently held by this database's two shared bounded caches. */
  cacheBytes(): { objects: number; chunks: number } {
    return this.shared.cacheBytes();
  }

  // -- objects --------------------------------------------------------

  /** Look up opaque filesystem content ids without interpreting their bytes. */
  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    return this.shared.lookupBlobIds(contentIds);
  }

  /**
   * Return the ordinals of expected mappings that are absent or disagree.
   *
   * An absent result proves the stored mapping equals the expected oid. A
   * `null` value means there is no stored mapping, so callers must identify
   * the content instead of trusting it.
   */
  blobIdMismatches(expected: Iterable<BlobIdMapping>): Map<number, string | null> {
    return this.shared.blobIdMismatches(expected);
  }

  /** Upsert opaque content-id mappings in bounded BLOB payloads. */
  upsertBlobIds(mappings: Iterable<BlobIdMapping>): void {
    this.shared.upsertBlobIds(mappings);
  }

  has(oid: string): boolean {
    return this.shared.has(oid);
  }

  hasAll(oids: Iterable<string>): Set<string> {
    return this.shared.hasAll(oids);
  }

  missing(oids: Iterable<string>): string[] {
    return this.shared.missing(oids);
  }

  registerPromisorRemote(remoteName: string, url: string): PromisorRemote {
    return this.shared.registerPromisorRemote(remoteName, url);
  }

  readPromisorRemote(remoteName: string): PromisorRemote | null {
    return this.shared.readPromisorRemote(remoteName);
  }

  addPromisedBlobs(remoteName: string, oids: Iterable<string>): void {
    this.shared.addPromisedBlobs(remoteName, oids);
  }

  addPromisedBlobsFromPackTrees(remoteName: string, packId: number): void {
    this.shared.addPromisedBlobsFromPackTrees(remoteName, packId);
  }

  promisedMissing(oids: readonly string[]): string[] {
    return this.shared.promisedMissing(oids);
  }

  promisedMissingDetails(oids: readonly string[]): PromisedBlob[] {
    return this.shared.promisedMissingDetails(oids);
  }

  promisedBlobCount(): number {
    return this.shared.promisedBlobCount();
  }

  *iteratePromisedBlobs(): Generator<PromisedBlob> {
    yield* this.shared.iteratePromisedBlobs();
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    return this.shared.typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    return this.shared.read(oid);
  }

  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    return this.shared.readAuthenticatedObject(oid, expectedType);
  }

  objectInfo(oids: readonly string[]): ObjectReadInfo[] {
    return this.shared.objectInfo(oids);
  }

  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    return this.shared.readObjects(oids, options);
  }

  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    return this.shared.readBlobs(oids, options);
  }

  *walkTree(treeOid: string): Generator<WalkTreeEntry> {
    yield* iterateTree(this.#db, this.#repoId, treeOid);
  }

  *walkTreeDiff(
    beforeTreeOid: string | null,
    afterTreeOid: string | null,
  ): Generator<WalkTreeDiffEntry> {
    yield* iterateTreeDiff(this.#db, this.#repoId, beforeTreeOid, afterTreeOid);
  }

  *walkTreeDiffObjects(
    beforeTreeOid: string | null,
    afterTreeOid: string,
  ): Generator<WalkTreeDiffObject> {
    yield* iterateTreeDiffObjects(this.#db, this.#repoId, beforeTreeOid, afterTreeOid);
  }

  write(type: ObjectType, data: Uint8Array): string {
    return this.shared.write(type, data);
  }

  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    return this.shared.writeStream(type, size, chunks);
  }

  writeBatch(options: ObjectBatchOptions = {}): ObjectBatch {
    return this.shared.writeBatch(options);
  }

  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    return this.shared.writeObjects(body, options);
  }

  readChunks(oid: string): Iterable<Uint8Array> | null {
    return this.shared.readChunks(oid);
  }

  resolvePrefix(prefix: string): string | null {
    return this.shared.resolvePrefix(prefix);
  }

  objectCount(): number {
    return this.shared.objectCount();
  }

  // -- refs -----------------------------------------------------------

  /** Raw ref value: an oid, or "ref: <name>" for a symbolic ref. */
  getRef(name: string): string | null {
    const checkedName = requireRefName(name, "ref name", "input", true);
    return checkedName === "HEAD" ? this.head() : this.shared.getRef(checkedName);
  }

  setRef(name: string, target: string): void {
    if (name === "HEAD") {
      this.setHead(target);
      return;
    }
    this.shared.setRef(name, target);
  }

  /** Move one direct ref only if it still contains the caller's observed OID. */
  updateRefExpected(name: string, expectedOid: string, targetOid: string): void {
    this.shared.updateRefExpected(name, expectedOid, targetOid);
  }

  deleteRef(name: string): void {
    if (name === "HEAD") {
      this.mutateRefs({ deletes: [name] }, this.#genericRefLogMetadata("ref delete"));
      return;
    }
    this.shared.deleteRef(name);
  }

  /** Apply bounded ref deletions and updates atomically. */
  updateRefs(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    this.shared.updateRefs(puts, deletes);
  }

  beginTrackingRefPublication(
    trackingPrefix: string,
    refName: string,
  ): TrackingRefPublicationToken {
    return this.shared.beginTrackingRefPublication(trackingPrefix, refName);
  }

  publishTrackingRef(
    token: TrackingRefPublicationToken,
    target: string | null,
    metadata: RefLogMetadata,
  ): boolean {
    return this.shared.publishTrackingRef(token, target, metadata);
  }

  beginFetchPublication(
    trackingPrefix: string,
    candidateExactRefs: Iterable<string> = [],
  ): FetchPublicationToken {
    return this.shared.beginFetchPublication(trackingPrefix, candidateExactRefs);
  }

  publishFetchRefs(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return this.shared.publishFetchRefs(token, plan, metadata);
  }

  /** Apply current ref state and its bounded history through one atomic seam. */
  mutateRefs(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    this.#requireActive();
    return this.#sharedStore.mutateRefsOwned(this.#headOwner, mutation, metadata);
  }

  listRefs(prefix = ""): RefRow[] {
    return this.shared.listRefs(prefix);
  }

  /** Stream all raw refs without materializing repository ref state. */
  *iterateRefs(): Generator<RefRow> {
    yield* this.shared.iterateRefs();
  }

  head(): string {
    const row = this.#db.one<Record<string, unknown>>(
      "SELECT head FROM git_checkouts WHERE id = ? AND repo_id = ?",
      this.#checkoutId,
      this.#repoId,
    );
    if (row === undefined) throw new CorruptError("checkout HEAD row is missing");
    return expectText(row.head, "stored HEAD target");
  }

  setHead(value: string): void {
    this.mutateRefs({ head: value }, this.#genericRefLogMetadata("HEAD update"));
  }

  #readRefMutationHeads(): CheckoutRow[] {
    const checkouts: CheckoutRow[] = [];
    for (const raw of this.#db.iterate(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
         FROM git_checkouts WHERE repo_id = ? ORDER BY id
         LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
      this.#repoId,
    )) {
      checkouts.push(requireStoredCheckoutRow(raw));
      if (checkouts.length > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "repository checkout state exceeds its retained bound");
      }
    }
    return checkouts;
  }

  #findAttachedBranchOwner(head: string): CheckoutRow | null {
    const attached = rawSymbolicTarget(head);
    if (attached?.startsWith("refs/heads/") !== true) return null;
    const owner = this.#db.one<Record<string, unknown>>(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
         FROM git_checkouts
        WHERE repo_id = ? AND head = ? AND id != ?
        LIMIT 1`,
      this.#repoId,
      head,
      this.#checkoutId,
    );
    if (owner === undefined) return null;
    const checkedOwner = requireStoredCheckoutRow(owner);
    if (checkedOwner.repoId !== this.#repoId || checkedOwner.head !== head) {
      throw new CorruptError("attached branch ownership crossed a repository boundary");
    }
    return checkedOwner;
  }

  #updateRefMutationHead(expectedHead: string, newHead: string): void {
    let updated: Record<string, unknown> | undefined;
    try {
      updated = this.#db.one<Record<string, unknown>>(
        `UPDATE git_checkouts SET head = ?
          WHERE id = ? AND repo_id = ? AND head = ?
          RETURNING id AS checkout_id, repo_id, root, head, is_primary`,
        newHead,
        this.#checkoutId,
        this.#repoId,
        expectedHead,
      );
    } catch (error) {
      if (isAttachedBranchUniqueConstraint(error)) {
        const owner = this.#findAttachedBranchOwner(newHead);
        if (owner !== null) {
          throw new GitError(
            "EBRANCHINUSE",
            `branch ${rawSymbolicTarget(newHead)} is already attached to checkout ${owner.root}`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    if (updated === undefined) {
      throw new CorruptError("selected checkout HEAD changed during ref mutation");
    }
    const checked = requireStoredCheckoutRow(updated);
    if (checked.id !== this.#checkoutId || checked.repoId !== this.#repoId) {
      throw new CorruptError("HEAD update crossed a checkout boundary");
    }
  }

  #appendCheckoutRefLogs(events: readonly CheckoutRefLogEvent[]): void {
    for (const page of jsonPages(events, "checkout reflog entry")) {
      this.#db.run(
        `INSERT INTO git_checkout_reflog_entries
           (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
            actor_name, actor_email, timestamp, timezone, reason)
         SELECT json_extract(value, '$.checkoutId'), ?,
                json_extract(value, '$.ordinal'),
                json_extract(value, '$.oldRaw'),
                json_extract(value, '$.newRaw'),
                json_extract(value, '$.oldOid'),
                json_extract(value, '$.newOid'),
                json_extract(value, '$.actorName'),
                json_extract(value, '$.actorEmail'),
                json_extract(value, '$.timestamp'),
                json_extract(value, '$.timezoneOffset'),
                json_extract(value, '$.reason')
           FROM json_each(?)`,
        this.#repoId,
        page,
      );
    }
  }

  #pruneExpiredCheckoutRefLogs(cutoff: number): void {
    this.#db.run(
      "DELETE FROM git_checkout_reflog_entries WHERE repo_id = ? AND timestamp < ?",
      this.#repoId,
      cutoff,
    );
  }

  #pruneRetainedCheckoutRefLogs(events: readonly CheckoutRefLogEvent[]): void {
    const touchedCheckouts = events.map((event) => event.checkoutId);
    for (const page of jsonPages(touchedCheckouts, "checkout reflog retention")) {
      this.#db.run(
        `DELETE FROM git_checkout_reflog_entries AS entry
          WHERE entry.repo_id = ?
            AND entry.checkout_id IN (SELECT value FROM json_each(?))
            AND entry.ordinal < coalesce((
              SELECT retained.ordinal
                FROM git_checkout_reflog_entries retained
               WHERE retained.checkout_id = entry.checkout_id
               ORDER BY retained.ordinal DESC
               LIMIT 1 OFFSET ${REFLOG_RETENTION_ROWS - 1}
            ), 0)`,
        this.#repoId,
        page,
      );
    }
  }

  /** Active stored entries for one exact ref, newest first. */
  reflog(refName: string, options: RefLogReadOptions = {}): RefLogEntry[] {
    return readRefLog(this.#db, this.#repoId, this.#checkoutId, this.#now, refName, options);
  }

  /** Distinct active reflog roots in strict byte order. */
  *activeRefLogOids(): Generator<string> {
    yield* activeRefLogOids(this.#db, this.#repoId, this.#checkoutId, this.#now);
  }

  // -- config ---------------------------------------------------------

  configGetAll(path: string): string[] {
    return this.shared.configGetAll(path);
  }

  configGet(path: string): string | undefined {
    return this.shared.configGet(path);
  }

  /** Read one config value with an optional payload limit. */
  configGetBounded(path: string, maxBytes?: number): string | undefined {
    return this.shared.configGetBounded(path, maxBytes);
  }

  /** Read zero or one value without materialising an unbounded multi-valued key. */
  configGetSingleBounded(path: string, maxBytes?: number): BoundedSingleConfigValue {
    return this.shared.configGetSingleBounded(path, maxBytes);
  }

  /** Inspect zero, one, or multiple values without materialising their payloads. */
  configCardinality(path: string): ConfigValueCardinality {
    return this.shared.configCardinality(path);
  }

  configSet(path: string, value: string): void {
    this.shared.configSet(path, value);
  }

  configAdd(path: string, value: string): void {
    this.shared.configAdd(path, value);
  }

  configUnset(path: string): void {
    this.shared.configUnset(path);
  }

  /** Distinct config paths under a dotted prefix, e.g. "remote.". */
  configPaths(prefix: string): string[] {
    return this.shared.configPaths(prefix);
  }

  /** Validate and move one exact dotted config section without changing value order. */
  configMoveSection(sourcePrefix: string, destinationPrefix: string): void {
    this.shared.configMoveSection(sourcePrefix, destinationPrefix);
  }

  // -- integration operation journal --------------------------------

  /** Read and validate the one durable incomplete integration operation. */
  readOperationState(): OperationJournal | null {
    this.#requireActive();
    return this.#operationJournals.readOperationState();
  }

  readOperationStateOwned(): OperationJournal | null {
    return this.readOperationState();
  }

  writeOperationState(state: OperationStateMetadata, touched: readonly MergeTouchedPath[]): void {
    this.#requireActive();
    this.#operationJournals.writeOperationState(state, touched);
  }

  writeOperationJournal(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.#requireActive();
    this.#operationJournals.writeOperationJournal(state, steps, touched);
  }

  writeOperationJournalOwned(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.writeOperationJournal(state, steps, touched);
  }

  replaceOperationState(expectedIntegrityOid: string, state: OperationStateMetadata): void {
    this.#requireActive();
    this.#operationJournals.replaceOperationState(expectedIntegrityOid, state);
  }

  replaceOperationStateOwned(expectedIntegrityOid: string, state: OperationStateMetadata): void {
    this.replaceOperationState(expectedIntegrityOid, state);
  }

  replaceOperationJournal(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.#requireActive();
    this.#operationJournals.replaceOperationJournal(expectedIntegrityOid, state, steps, touched);
  }

  replaceOperationJournalOwned(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.replaceOperationJournal(expectedIntegrityOid, state, steps, touched);
  }

  clearOperationState(): boolean {
    this.#requireActive();
    return this.#operationJournals.clearOperationState();
  }

  requireNoOperationState(): void {
    this.#requireActive();
    this.#operationJournals.requireNoOperationState();
  }

  requireOperationState(kind: "merge"): MergeOperationJournal;
  requireOperationState(kind: "cherry-pick"): CherryPickJournal;
  requireOperationState(kind: "revert"): RevertJournal;
  requireOperationState(kind: "rebase"): RebaseJournal;
  requireOperationState(kind: OperationKind): OperationJournal;
  requireOperationState(kind: OperationKind): OperationJournal {
    this.#requireActive();
    return this.#operationJournals.requireOperationState(kind);
  }

  readMergeState(): MergeJournal | null {
    this.#requireActive();
    return this.#operationJournals.readMergeState();
  }

  writeMergeState(state: MergeStateMetadata, touched: readonly MergeTouchedPath[]): void {
    this.#requireActive();
    this.#operationJournals.writeMergeState(state, touched);
  }

  clearMergeState(): boolean {
    this.#requireActive();
    return this.#operationJournals.clearMergeState();
  }

  requireNoMergeState(): void {
    this.#requireActive();
    this.#operationJournals.requireNoMergeState();
  }

  requireMergeState(): MergeJournal {
    this.#requireActive();
    return this.#operationJournals.requireMergeState();
  }

  // -- index ----------------------------------------------------------

  /** Create clone state only while every index stage is still empty. */
  tryCreateInitialState<T>(body: (session: InitialStateSession) => T): InitialStateResult<T> {
    return this.#indexTable.tryCreateInitialState(body);
  }

  indexEntries(): IndexEntry[] {
    return this.#indexTable.indexEntries();
  }

  indexGet(path: string, stage = 0): IndexEntry | null {
    return this.#indexTable.indexGet(path, stage);
  }

  indexPut(entry: IndexEntry): void {
    this.#indexTable.indexPut(entry);
  }

  indexRemove(path: string): void {
    this.#indexTable.indexRemove(path);
  }

  indexClear(): void {
    this.#indexTable.indexClear();
  }

  indexReplace(entries: Iterable<IndexEntry>, options: IndexApplyOptions = {}): void {
    this.#indexTable.indexReplace(entries, options);
  }

  *indexScan(options: IndexScanOptions = {}): Generator<IndexEntry> {
    yield* this.#indexTable.indexScan(options);
  }

  indexApply<T>(body: (sink: IndexSink) => T, options: IndexApplyOptions = {}): T {
    return this.#indexTable.indexApply(body, options);
  }

  hasConflicts(): boolean {
    return this.#indexTable.hasConflicts();
  }

  hasCheckoutBlockingIndexEntries(): boolean {
    return this.#indexTable.hasCheckoutBlockingIndexEntries();
  }

  /** Read a complete parsed commit while its exact raw source remains valid. */
  cachedCommit(oid: string): CommitCacheEntry | null {
    return readCommitCache(this.#db, this.#repoId, oid);
  }

  /** Validate raw bytes and prepare an opaque point-cache entry without writing it. */
  prepareCommit(oid: string, data: Uint8Array): CommitCacheEntry {
    return prepareCommitCache({ repoId: this.#repoId, oid, data });
  }

  /** Lazily add one derived commit row from bytes the caller already read. */
  cacheCommit(oid: string, data: Uint8Array): CommitCacheEntry | null {
    return indexCommitSource(this.#db, { repoId: this.#repoId, oid, data });
  }

  /** Insert prepared point misses with the shared row and JSON byte bounds. */
  cacheCommits(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult {
    return insertCommitCaches(this.#db, entries);
  }

  /** Parsed commits reachable from `rootOid`, read by one bounded recursive cursor. */
  commitGraph(rootOid: string, limits: CommitGraphLimits = {}): Iterable<CommitCacheEntry> {
    return readCommitGraph(this.#db, this.#repoId, rootOid, limits);
  }

  // -- shallow --------------------------------------------------------

  shallow(): Set<string> {
    return this.shared.shallow();
  }

  setShallow(add: Iterable<string>, remove: Iterable<string> = []): void {
    this.shared.setShallow(add, remove);
  }

  #genericRefLogMetadata(reason: string): RefLogMetadata {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new GitError("EINVAL", "Git store clock must return non-negative integer milliseconds");
    }
    return {
      actor: null,
      reason,
      timestamp: Math.floor(now / 1_000),
      timezoneOffset: 0,
    };
  }

  // -- lifecycle ------------------------------------------------------

  /** Drop the shared store and every checkout through foreign-key cascades. */
  destroy(): void {
    this.#requireActive();
    if (this.#onDestroy !== undefined) {
      this.#db.transactionSync(this.#onDestroy);
      return;
    }
    this.#db.transactionSync(() => {
      this.#db.run("DELETE FROM git_repositories WHERE id = ?", this.#repoId);
    });
    this.shared.clearCaches();
  }
}
