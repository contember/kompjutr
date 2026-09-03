import type * as Api from "./checkout-api.js";
import { requireCheckoutStoreMutations } from "./checkout-mutations.js";
import { createCheckoutStoreState, NEVER_AUTHORIZE_LIFECYCLE_MUTATION } from "./checkout-wiring.js";
import { requireConfigPath, requireConfigSectionMove } from "./config.js";
import { CheckoutStoreLifetime } from "./lifecycle.js";
import { sharedRepoStoreMutations, writeObjectsOwned } from "./shared.js";
import { iterateTree, iterateTreeDiff, iterateTreeDiffObjects } from "./tree-walk.js";

export const DEFAULT_OBJECT_CACHE_BYTES = 8 * 1024 * 1024;

/** Internal mutation capability; intentionally absent from the package facade. */
export function checkoutStoreMutations(store: CheckoutStore): Api.CheckoutStoreMutations {
  return requireCheckoutStoreMutations(store);
}

export class CheckoutStore implements Api.IndexStore {
  readonly #state: Api.CheckoutStoreState;

  constructor(
    shared: Api.SharedRepoStore,
    checkout: Api.CheckoutRow,
    options: Api.StoreOptions = {},
    onDestroy?: () => void,
    lifetime = new CheckoutStoreLifetime(),
    isLifecycleMutationAuthorized: (
      store: CheckoutStore,
    ) => boolean = NEVER_AUTHORIZE_LIFECYCLE_MUTATION,
  ) {
    this.#state = createCheckoutStoreState({
      store: this,
      shared,
      checkout,
      options,
      onDestroy,
      lifetime,
      isLifecycleMutationAuthorized,
    });
  }

  #mutate<T>(body: () => T): T {
    return this.#state.mutate(body);
  }

  get shared(): Api.SharedRepoStore {
    return this.#state.activeShared();
  }

  get #db(): Api.SqlDatabase {
    return this.#state.activeDatabase();
  }

  get db(): Api.SqlDatabase {
    return this.#db;
  }

  get repoId(): number {
    return this.#state.repoId;
  }

  get sharedRepoId(): number {
    return this.#state.repoId;
  }

  get checkoutId(): number {
    return this.#state.checkoutId;
  }

  get root(): string {
    return this.#state.root;
  }

  get isPrimary(): boolean {
    return this.#state.isPrimary;
  }

  get packs(): Api.PackStore {
    return this.shared.packs;
  }

  cacheBytes(): { objects: number; chunks: number } {
    return this.shared.cacheBytes();
  }

  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    return this.shared.lookupBlobIds(contentIds);
  }

  blobIdMismatches(expected: Iterable<Api.BlobIdMapping>): Map<number, string | null> {
    return this.shared.blobIdMismatches(expected);
  }

  upsertBlobIds(mappings: Iterable<Api.BlobIdMapping>): void {
    this.#mutate(() => this.#state.mutations.upsertBlobIdsOwned(mappings));
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

  registerPromisorRemote(remoteName: string, url: string): Api.PromisorRemote {
    return this.#mutate(() => this.#state.mutations.registerPromisorRemoteOwned(remoteName, url));
  }

  readPromisorRemote(remoteName: string): Api.PromisorRemote | null {
    return this.shared.readPromisorRemote(remoteName);
  }

  addPromisedBlobs(remoteName: string, oids: Iterable<string>): void {
    this.#mutate(() => this.#state.mutations.addPromisedBlobsOwned(remoteName, oids));
  }

  addPromisedBlobsFromPackTrees(remoteName: string, packId: number): void {
    this.#mutate(() =>
      this.#state.mutations.addPromisedBlobsFromPackTreesOwned(remoteName, packId),
    );
  }

  promisedMissing(oids: readonly string[]): string[] {
    return this.shared.promisedMissing(oids);
  }

  promisedMissingDetails(oids: readonly string[]): Api.PromisedBlob[] {
    return this.shared.promisedMissingDetails(oids);
  }

  promisedBlobCount(): number {
    return this.shared.promisedBlobCount();
  }

  *iteratePromisedBlobs(): Generator<Api.PromisedBlob> {
    yield* this.shared.iteratePromisedBlobs();
  }

  typeAndSize(oid: string): { type: Api.ObjectType; size: number } | null {
    return this.shared.typeAndSize(oid);
  }

  read(oid: string): Api.RawObject | null {
    return this.shared.read(oid);
  }

  readAuthenticatedObject(oid: string, expectedType: Api.ObjectType): Api.RawObject | null {
    return this.shared.readAuthenticatedObject(oid, expectedType);
  }

  objectInfo(oids: readonly string[]): Api.ObjectReadInfo[] {
    return this.shared.objectInfo(oids);
  }

  readObjects(
    oids: readonly string[],
    options: { budgetBytes?: number } = {},
  ): Api.ObjectReadBatch {
    return this.shared.readObjects(oids, options);
  }

  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): Api.BlobReadBatch {
    return this.shared.readBlobs(oids, options);
  }

  *walkTree(treeOid: string): Generator<Api.WalkTreeEntry> {
    yield* iterateTree(this.#db, this.#state.repoId, treeOid);
  }

  *walkTreeDiff(
    beforeTreeOid: string | null,
    afterTreeOid: string | null,
  ): Generator<Api.WalkTreeDiffEntry> {
    yield* iterateTreeDiff(this.#db, this.#state.repoId, beforeTreeOid, afterTreeOid);
  }

  *walkTreeDiffObjects(
    beforeTreeOid: string | null,
    afterTreeOid: string,
  ): Generator<Api.WalkTreeDiffObject> {
    yield* iterateTreeDiffObjects(this.#db, this.#state.repoId, beforeTreeOid, afterTreeOid);
  }

  write(type: Api.ObjectType, data: Uint8Array): string {
    return this.#mutate(() => this.#state.mutations.writeOwned(type, data));
  }

  writeStream(type: Api.ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    return this.#mutate(() => this.#state.mutations.writeStreamOwned(type, size, chunks));
  }

  writeBatch(options: Api.ObjectBatchOptions = {}): Api.ObjectBatch {
    return sharedRepoStoreMutations(this.shared)
      .objectTableOwned()
      .writeBatchGuarded(options, (body) => this.#mutate(body));
  }

  writeObjects<T>(body: (batch: Api.ObjectBatch) => T, options: Api.ObjectBatchOptions = {}): T {
    return this.#mutate(() => writeObjectsOwned(this.shared, body, options));
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

  getRef(name: string): string | null {
    return this.#state.refs.getRef(name);
  }

  setRef(name: string, target: string): void {
    this.#mutate(() => this.#state.mutations.setRefOwned(name, target));
  }

  updateRefExpected(name: string, expectedOid: string, targetOid: string): void {
    this.#mutate(() => this.#state.mutations.updateRefExpectedOwned(name, expectedOid, targetOid));
  }

  deleteRef(name: string): void {
    this.#mutate(() => this.#state.mutations.deleteRefOwned(name));
  }

  updateRefs(puts: Iterable<Api.RefRow>, deletes: Iterable<string> = []): void {
    this.#mutate(() => this.#state.mutations.updateRefsOwned(puts, deletes));
  }

  beginTrackingRefPublication(
    trackingPrefix: string,
    refName: string,
  ): Api.TrackingRefPublicationToken {
    return this.#state.refs.beginTrackingRefPublication(trackingPrefix, refName);
  }

  publishTrackingRef(
    token: Api.TrackingRefPublicationToken,
    target: string | null,
    metadata: Api.RefLogMetadata,
  ): boolean {
    return this.#mutate(() =>
      this.#state.mutations.publishTrackingRefOwned(token, target, metadata),
    );
  }

  beginFetchPublication(
    trackingPrefix: string,
    candidateExactRefs: Iterable<string> = [],
  ): Api.FetchPublicationToken {
    return this.#state.refs.beginFetchPublication(trackingPrefix, candidateExactRefs);
  }

  publishFetchRefs(
    token: Api.FetchPublicationToken,
    plan: Api.FetchPublicationPlan,
    metadata: Api.RefLogMetadata,
  ): boolean {
    return this.#mutate(() => this.#state.mutations.publishFetchRefsOwned(token, plan, metadata));
  }

  mutateRefs(mutation: Api.RefMutation, metadata: Api.RefLogMetadata): boolean {
    return this.#mutate(() => this.#state.mutations.mutateRefsOwned(mutation, metadata));
  }

  listRefs(prefix = ""): Api.RefRow[] {
    return this.#state.refs.listRefs(prefix);
  }

  *iterateRefs(): Generator<Api.RefRow> {
    yield* this.#state.refs.iterateRefs();
  }

  head(): string {
    return this.#state.refs.head();
  }

  setHead(value: string): void {
    this.mutateRefs({ head: value }, this.#state.refs.genericRefLogMetadata("HEAD update"));
  }

  reflog(refName: string, options: Api.RefLogReadOptions = {}): Api.RefLogEntry[] {
    return this.#state.refs.reflog(refName, options);
  }

  *activeRefLogOids(): Generator<string> {
    yield* this.#state.refs.activeRefLogOids();
  }

  configGetAll(path: string): string[] {
    return this.shared.configGetAll(path);
  }

  configGet(path: string): string | undefined {
    return this.shared.configGet(path);
  }

  configGetBounded(path: string, maxBytes?: number): string | undefined {
    return this.shared.configGetBounded(path, maxBytes);
  }

  configGetSingleBounded(path: string, maxBytes?: number): Api.BoundedSingleConfigValue {
    return this.shared.configGetSingleBounded(path, maxBytes);
  }

  configCardinality(path: string): Api.ConfigValueCardinality {
    return this.shared.configCardinality(path);
  }

  configSet(path: string, value: string): void {
    const checkedPath = requireConfigPath(path);
    this.#mutate(() => this.#state.mutations.configSetOwned(checkedPath, value));
  }

  configAdd(path: string, value: string): void {
    const checkedPath = requireConfigPath(path);
    this.#mutate(() => this.#state.mutations.configAddOwned(checkedPath, value));
  }

  configUnset(path: string): void {
    const checkedPath = requireConfigPath(path);
    this.#mutate(() => this.#state.mutations.configUnsetOwned(checkedPath));
  }

  configPaths(prefix: string): string[] {
    return this.shared.configPaths(prefix);
  }

  configMoveSection(sourcePrefix: string, destinationPrefix: string): void {
    const [source, destination] = requireConfigSectionMove(sourcePrefix, destinationPrefix);
    this.#mutate(() => this.#state.mutations.configMoveSectionOwned(source, destination));
  }

  readOperationState(): Api.OperationJournal | null {
    return this.#state.operations.readOperationState();
  }

  readOperationStateOwned(): Api.OperationJournal | null {
    return this.readOperationState();
  }

  readRebaseCursorOwned(): Api.RebaseJournalCursor | null {
    return this.#state.operations.readRebaseCursorOwned();
  }

  writeOperationState(
    state: Api.OperationStateMetadata,
    touched: readonly Api.MergeTouchedPath[],
  ): void {
    this.#mutate(() => this.#state.mutations.writeOperationStateOwned(state, touched));
  }

  writeOperationJournal(
    state: Api.OperationStateMetadata,
    steps: readonly Api.OperationStepMetadata[],
    touched: readonly Api.MergeTouchedPath[],
  ): void {
    this.#mutate(() => this.#state.mutations.writeOperationJournalOwned(state, steps, touched));
  }

  operationRootPage(cursor = 0, limit = 128): Api.OperationRootPage {
    return this.#state.operations.operationRootPage(cursor, limit);
  }

  clearOperationState(): boolean {
    return this.#mutate(() => this.#state.mutations.clearOperationStateOwned());
  }

  requireNoOperationState(): void {
    this.#state.operations.requireNoOperationState();
  }

  requireOperationState(kind: "merge"): Api.MergeOperationJournal;
  requireOperationState(kind: "cherry-pick"): Api.CherryPickJournal;
  requireOperationState(kind: "revert"): Api.RevertJournal;
  requireOperationState(kind: "rebase"): Api.RebaseJournal;
  requireOperationState(kind: Api.OperationKind): Api.OperationJournal;
  requireOperationState(kind: Api.OperationKind): Api.OperationJournal {
    return this.#state.operations.requireOperationState(kind);
  }

  readMergeState(): Api.MergeJournal | null {
    return this.#state.operations.readMergeState();
  }

  writeMergeState(state: Api.MergeStateMetadata, touched: readonly Api.MergeTouchedPath[]): void {
    this.#mutate(() => this.#state.mutations.writeMergeStateOwned(state, touched));
  }

  clearMergeState(): boolean {
    return this.#mutate(() => this.#state.mutations.clearMergeStateOwned());
  }

  requireNoMergeState(): void {
    this.#state.operations.requireNoMergeState();
  }

  requireMergeState(): Api.MergeJournal {
    return this.#state.operations.requireMergeState();
  }

  tryCreateInitialState<T>(
    body: (session: Api.InitialStateSession) => T,
  ): Api.InitialStateResult<T> {
    return this.#mutate(() => this.#state.mutations.tryCreateInitialStateOwned(body));
  }

  indexEntries(): Api.IndexEntry[] {
    return this.#state.index.indexEntries();
  }

  indexGet(path: string, stage = 0): Api.IndexEntry | null {
    return this.#state.index.indexGet(path, stage);
  }

  indexPut(entry: Api.IndexEntry): void {
    this.#mutate(() => this.#state.mutations.indexPutOwned(entry));
  }

  indexRemove(path: string): void {
    this.#mutate(() => this.#state.mutations.indexRemoveOwned(path));
  }

  indexClear(): void {
    this.#mutate(() => this.#state.mutations.indexClearOwned());
  }

  indexReplace(entries: Iterable<Api.IndexEntry>, options: Api.IndexApplyOptions = {}): void {
    this.#mutate(() => this.#state.mutations.indexReplaceOwned(entries, options));
  }

  *indexScan(options: Api.IndexScanOptions = {}): Generator<Api.IndexEntry> {
    yield* this.#state.index.indexScan(options);
  }

  indexApply<T>(body: (sink: Api.IndexSink) => T, options: Api.IndexApplyOptions = {}): T {
    return this.#mutate(() => this.#state.mutations.indexApplyOwned(body, options));
  }

  hasConflicts(): boolean {
    return this.#state.index.hasConflicts();
  }

  hasCheckoutBlockingIndexEntries(): boolean {
    return this.#state.index.hasCheckoutBlockingIndexEntries();
  }

  cachedCommit(oid: string): Api.CommitCacheEntry | null {
    return this.#state.index.cachedCommit(oid);
  }

  prepareCommit(oid: string, data: Uint8Array): Api.CommitCacheEntry {
    return this.#state.index.prepareCommit(oid, data);
  }

  cacheCommit(oid: string, data: Uint8Array): Api.CommitCacheEntry | null {
    return this.#mutate(() => this.#state.mutations.cacheCommitOwned(oid, data));
  }

  cacheCommits(entries: Iterable<Api.CommitCacheEntry>): Api.CommitCacheWriteResult {
    return this.#mutate(() => this.#state.mutations.cacheCommitsOwned(entries));
  }

  commitGraph(rootOid: string, limits: Api.CommitGraphLimits = {}): Iterable<Api.CommitCacheEntry> {
    return this.#state.index.commitGraph(rootOid, limits);
  }

  shallow(): Set<string> {
    return this.shared.shallow();
  }

  setShallow(add: Iterable<string>, remove: Iterable<string> = []): void {
    this.#mutate(() => this.#state.mutations.setShallowOwned(add, remove));
  }

  destroy(): void {
    this.#mutate(() => this.#state.mutations.destroyOwned());
  }
}

/** Internal index mutation composition for checkout and scratch index implementations. */
export function applyIndexOwned<T>(
  index: Api.IndexStore,
  body: (sink: Api.IndexSink) => T,
  options: Api.IndexApplyOptions = {},
): T {
  if (index instanceof CheckoutStore) {
    return checkoutStoreMutations(index).indexApplyOwned(body, options);
  }
  return index.indexApply(body, options);
}
