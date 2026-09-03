import { CorruptError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import type {
  BlobIdMapping,
  FetchPublicationPlan,
  FetchPublicationToken,
  IndexApplyOptions,
  IndexEntry,
  IndexSink,
  InitialStateResult,
  InitialStateSession,
  PromisorRemote,
  RefLogMetadata,
  RefMutation,
  RefRow,
  TrackingRefPublicationToken,
} from "../core/contracts.js";
import type {
  MergeSavedIdentity,
  MergeStateMetadata,
  MergeTouchedPath,
  OperationStateMetadata,
  OperationStepMetadata,
} from "../operations/operations.js";
import { type SharedRepoStore, sharedRepoStoreMutations } from "../repository/shared.js";
import type { CommitCacheEntry, CommitCacheWriteResult } from "../trees/commits.js";
import type { CheckoutIndexStore } from "./checkout-index.js";
import type { CheckoutOperationStore } from "./checkout-operation.js";
import type { CheckoutRefStore } from "./checkout-refs.js";

export interface CheckoutStoreMutations {
  upsertBlobIdsOwned(mappings: Iterable<BlobIdMapping>): void;
  registerPromisorRemoteOwned(remoteName: string, url: string): PromisorRemote;
  addPromisedBlobsOwned(remoteName: string, oids: Iterable<string>): void;
  addPromisedBlobsFromPackTreesOwned(remoteName: string, packId: number): void;
  writeOwned(type: ObjectType, data: Uint8Array): string;
  writeStreamOwned(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string;
  setRefOwned(name: string, target: string): void;
  updateRefExpectedOwned(name: string, expectedOid: string, targetOid: string): void;
  deleteRefOwned(name: string): void;
  updateRefsOwned(puts: Iterable<RefRow>, deletes?: Iterable<string>): void;
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
  mutateRefsOwned(mutation: RefMutation, metadata: RefLogMetadata): boolean;
  setHeadOwned(value: string): void;
  configSetOwned(path: string, value: string): void;
  configAddOwned(path: string, value: string): void;
  configUnsetOwned(path: string): void;
  configMoveSectionOwned(sourcePrefix: string, destinationPrefix: string): void;
  writeOperationStateOwned(
    state: OperationStateMetadata,
    touched: readonly MergeTouchedPath[],
  ): void;
  writeOperationJournalOwned(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void;
  markReplayEmptyOwned(kind: "cherry-pick" | "revert", reason: "source" | "result"): void;
  suspendRebaseOwned(currentStep: number, touched: readonly MergeTouchedPath[]): void;
  advanceRebaseOwned(
    phase: "running" | "conflicted",
    currentStep: number,
    outcome: "applied" | "skipped",
    resultOid: string | null,
    currentParentOid: string,
    committer: MergeSavedIdentity | null,
  ): void;
  clearOperationStateOwned(): boolean;
  writeMergeStateOwned(state: MergeStateMetadata, touched: readonly MergeTouchedPath[]): void;
  clearMergeStateOwned(): boolean;
  tryCreateInitialStateOwned<T>(body: (session: InitialStateSession) => T): InitialStateResult<T>;
  indexPutOwned(entry: IndexEntry): void;
  indexRemoveOwned(path: string): void;
  indexClearOwned(): void;
  indexApplyOwned<T>(body: (sink: IndexSink) => T, options?: IndexApplyOptions): T;
  indexReplaceOwned(entries: Iterable<IndexEntry>, options?: IndexApplyOptions): void;
  cacheCommitOwned(oid: string, data: Uint8Array): CommitCacheEntry | null;
  cacheCommitsOwned(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult;
  setShallowOwned(add: Iterable<string>, remove?: Iterable<string>): void;
  destroyOwned(): void;
}

export interface CheckoutMutationDependencies {
  readonly shared: () => SharedRepoStore;
  readonly refs: CheckoutRefStore;
  readonly operations: CheckoutOperationStore;
  readonly index: CheckoutIndexStore;
  readonly destroyOwned: () => void;
}

export function createCheckoutStoreMutations(
  dependencies: CheckoutMutationDependencies,
): CheckoutStoreMutations {
  const sharedMutations = () => sharedRepoStoreMutations(dependencies.shared());
  return {
    upsertBlobIdsOwned: (mappings) => sharedMutations().upsertBlobIdsOwned(mappings),
    registerPromisorRemoteOwned: (remoteName, url) =>
      sharedMutations().registerPromisorRemoteOwned(remoteName, url),
    addPromisedBlobsOwned: (remoteName, oids) =>
      sharedMutations().addPromisedBlobsOwned(remoteName, oids),
    addPromisedBlobsFromPackTreesOwned: (remoteName, packId) =>
      sharedMutations().addPromisedBlobsFromPackTreesOwned(remoteName, packId),
    writeOwned: (type, data) => sharedMutations().writeOwned(type, data),
    writeStreamOwned: (type, size, chunks) =>
      sharedMutations().writeStreamOwned(type, size, chunks),
    setRefOwned: (name, target) => dependencies.refs.setRefOwned(name, target),
    updateRefExpectedOwned: (name, expectedOid, targetOid) =>
      dependencies.refs.updateRefExpectedOwned(name, expectedOid, targetOid),
    deleteRefOwned: (name) => dependencies.refs.deleteRefOwned(name),
    updateRefsOwned: (puts, deletes) => dependencies.refs.updateRefsOwned(puts, deletes),
    publishTrackingRefOwned: (token, target, metadata) =>
      dependencies.refs.publishTrackingRefOwned(token, target, metadata),
    publishFetchRefsOwned: (token, plan, metadata) =>
      dependencies.refs.publishFetchRefsOwned(token, plan, metadata),
    mutateRefsOwned: (mutation, metadata) => dependencies.refs.mutateRefsOwned(mutation, metadata),
    setHeadOwned: (value) => dependencies.refs.setHeadOwned(value),
    configSetOwned: (path, value) => sharedMutations().configSetOwned(path, value),
    configAddOwned: (path, value) => sharedMutations().configAddOwned(path, value),
    configUnsetOwned: (path) => sharedMutations().configUnsetOwned(path),
    configMoveSectionOwned: (sourcePrefix, destinationPrefix) =>
      sharedMutations().configMoveSectionOwned(sourcePrefix, destinationPrefix),
    writeOperationStateOwned: (state, touched) =>
      dependencies.operations.writeOperationStateOwned(state, touched),
    writeOperationJournalOwned: (state, steps, touched) =>
      dependencies.operations.writeOperationJournalOwned(state, steps, touched),
    markReplayEmptyOwned: (kind, reason) =>
      dependencies.operations.markReplayEmptyOwned(kind, reason),
    suspendRebaseOwned: (currentStep, touched) =>
      dependencies.operations.suspendRebaseOwned(currentStep, touched),
    advanceRebaseOwned: (phase, currentStep, outcome, resultOid, currentParentOid, committer) =>
      dependencies.operations.advanceRebaseOwned(
        phase,
        currentStep,
        outcome,
        resultOid,
        currentParentOid,
        committer,
      ),
    clearOperationStateOwned: () => dependencies.operations.clearOperationStateOwned(),
    writeMergeStateOwned: (state, touched) =>
      dependencies.operations.writeMergeStateOwned(state, touched),
    clearMergeStateOwned: () => dependencies.operations.clearMergeStateOwned(),
    tryCreateInitialStateOwned: (body) => dependencies.index.tryCreateInitialStateOwned(body),
    indexPutOwned: (entry) => dependencies.index.indexPutOwned(entry),
    indexRemoveOwned: (path) => dependencies.index.indexRemoveOwned(path),
    indexClearOwned: () => dependencies.index.indexClearOwned(),
    indexApplyOwned: (body, options) => dependencies.index.indexApplyOwned(body, options),
    indexReplaceOwned: (entries, options) => dependencies.index.indexReplaceOwned(entries, options),
    cacheCommitOwned: (oid, data) => dependencies.index.cacheCommitOwned(oid, data),
    cacheCommitsOwned: (entries) => dependencies.index.cacheCommitsOwned(entries),
    setShallowOwned: (add, remove) => sharedMutations().setShallowOwned(add, remove),
    destroyOwned: () => dependencies.destroyOwned(),
  };
}

const CHECKOUT_STORE_MUTATIONS = new WeakMap<object, CheckoutStoreMutations>();

export function bindCheckoutStoreMutations(store: object, mutations: CheckoutStoreMutations): void {
  CHECKOUT_STORE_MUTATIONS.set(store, mutations);
}

export function requireCheckoutStoreMutations(store: object): CheckoutStoreMutations {
  const mutations = CHECKOUT_STORE_MUTATIONS.get(store);
  if (mutations === undefined) {
    throw new CorruptError("checkout store mutation capability is missing");
  }
  return mutations;
}
