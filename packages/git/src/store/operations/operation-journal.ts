import type { SqlDatabase } from "@kompjutr/sqlite";
import type { CheckoutStore } from "../checkout/checkout.js";
import { checkoutStoreMutations } from "../core/checkout-mutations-registry.js";
import type { ObjectTable } from "../objects/objects.js";
import { readOperationState, readRebaseCursor } from "./operation-journal-read.js";
import { operationRootPage as readOperationRootPage } from "./operation-journal-roots.js";
import type { OperationRootPage, RebaseJournalCursor } from "./operation-journal-types.js";
import {
  clearOperationState as deleteOperationState,
  type OperationJournalWriteContext,
  writeOperationJournal as persistOperationJournal,
  writeOperationState as persistOperationState,
  advanceRebase as transitionRebase,
  suspendRebase as transitionRebaseSuspension,
  markReplayEmpty as transitionReplayEmpty,
} from "./operation-journal-write.js";
import {
  type CherryPickJournal,
  type MergeJournal,
  type MergeOperationJournal,
  type MergeSavedIdentity,
  type MergeStateMetadata,
  type MergeTouchedPath,
  mergeJournalFromOperation,
  mergeOperationState,
  type OperationJournal,
  type OperationKind,
  type OperationStateMetadata,
  type OperationStepMetadata,
  operationAlreadyActive,
  operationKindMismatch,
  operationNotActive,
  type RebaseJournal,
  type RevertJournal,
} from "./operations.js";

export {
  operationIdentityFromRow,
  operationIndexFromRow,
  operationJournal,
  operationMetadataFromRow,
  operationStepFromRow,
  operationTouchedFromRow,
  operationWorktreeFromRow,
  persistedOperationStep,
  persistedOperationTouched,
  requireNullableMainline,
  requireNullableOperationOid,
  requireOperationKind,
} from "./operation-journal-rows.js";
export type {
  ExpectedOperationObject,
  OperationRootPage,
  OperationStateRow,
  OperationStepRow,
  OperationTouchedRow,
  PersistedOperationStep,
  PersistedOperationTouched,
  RebaseJournalCursor,
} from "./operation-journal-types.js";

export interface OperationJournalOwner {
  readOperationStateOwned(): OperationJournal | null;
  readRebaseCursorOwned(): RebaseJournalCursor | null;
}

export function readOperationStateOwned(store: OperationJournalOwner): OperationJournal | null {
  return store.readOperationStateOwned();
}

export function readRebaseCursorOwned(store: OperationJournalOwner): RebaseJournalCursor | null {
  return store.readRebaseCursorOwned();
}

export function writeOperationJournalOwned(
  store: CheckoutStore,
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
): void {
  checkoutStoreMutations(store).writeOperationJournalOwned(state, steps, touched);
}

export function markReplayEmptyOwned(
  store: CheckoutStore,
  kind: "cherry-pick" | "revert",
  reason: "source" | "result",
): void {
  checkoutStoreMutations(store).markReplayEmptyOwned(kind, reason);
}

export function suspendRebaseOwned(
  store: CheckoutStore,
  currentStep: number,
  touched: readonly MergeTouchedPath[],
): void {
  checkoutStoreMutations(store).suspendRebaseOwned(currentStep, touched);
}

export function advanceRebaseOwned(
  store: CheckoutStore,
  phase: "running" | "conflicted",
  currentStep: number,
  outcome: "applied" | "skipped",
  resultOid: string | null,
  currentParentOid: string,
  committer: MergeSavedIdentity | null,
): void {
  checkoutStoreMutations(store).advanceRebaseOwned(
    phase,
    currentStep,
    outcome,
    resultOid,
    currentParentOid,
    committer,
  );
}

export class OperationJournalTable {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly checkoutId: number,
    private readonly objects: ObjectTable,
  ) {}

  readOperationState(): OperationJournal | null {
    return readOperationState(this.db, this.checkoutId);
  }

  readRebaseCursorOwned(): RebaseJournalCursor | null {
    return readRebaseCursor(this.db, this.checkoutId);
  }

  writeOperationState(state: OperationStateMetadata, touched: readonly MergeTouchedPath[]): void {
    persistOperationState(this.#writeContext(), state, touched);
  }

  writeOperationJournal(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    persistOperationJournal(this.#writeContext(), state, steps, touched);
  }

  markReplayEmpty(kind: "cherry-pick" | "revert", reason: "source" | "result"): void {
    transitionReplayEmpty(this.#writeContext(), kind, reason);
  }

  suspendRebase(currentStep: number, touched: readonly MergeTouchedPath[]): void {
    transitionRebaseSuspension(this.#writeContext(), currentStep, touched);
  }

  advanceRebase(
    phase: "running" | "conflicted",
    currentStep: number,
    outcome: "applied" | "skipped",
    resultOid: string | null,
    currentParentOid: string,
    committer: MergeSavedIdentity | null,
  ): void {
    transitionRebase(
      this.#writeContext(),
      phase,
      currentStep,
      outcome,
      resultOid,
      currentParentOid,
      committer,
    );
  }

  clearOperationState(): boolean {
    return deleteOperationState(this.#writeContext());
  }

  requireNoOperationState(): void {
    const active = this.readOperationState();
    if (active !== null) throw operationAlreadyActive(active.state.kind);
  }

  requireOperationState(kind: "merge"): MergeOperationJournal;
  requireOperationState(kind: "cherry-pick"): CherryPickJournal;
  requireOperationState(kind: "revert"): RevertJournal;
  requireOperationState(kind: "rebase"): RebaseJournal;
  requireOperationState(kind: OperationKind): OperationJournal;
  requireOperationState(kind: OperationKind): OperationJournal {
    const journal = this.readOperationState();
    if (journal === null) throw operationNotActive(kind);
    if (journal.kind !== kind) throw operationKindMismatch(kind, journal.kind);
    return journal;
  }

  operationRootPage(cursor = 0, limit = 128): OperationRootPage {
    return readOperationRootPage(this.db, this.checkoutId, cursor, limit);
  }

  readMergeState(): MergeJournal | null {
    const journal = this.readOperationState();
    if (journal === null) return null;
    if (journal.kind !== "merge") throw operationKindMismatch("merge", journal.kind);
    return mergeJournalFromOperation(journal);
  }

  writeMergeState(state: MergeStateMetadata, touched: readonly MergeTouchedPath[]): void {
    this.writeOperationState(mergeOperationState(state), touched);
  }

  clearMergeState(): boolean {
    return this.clearOperationState();
  }

  requireNoMergeState(): void {
    this.requireNoOperationState();
  }

  requireMergeState(): MergeJournal {
    return mergeJournalFromOperation(this.requireOperationState("merge"));
  }

  #writeContext(): OperationJournalWriteContext {
    return {
      db: this.db,
      repoId: this.repoId,
      checkoutId: this.checkoutId,
      objects: this.objects,
    };
  }
}
