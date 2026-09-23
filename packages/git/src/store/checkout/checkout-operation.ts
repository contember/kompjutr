import type { SqlDatabase } from "@kompjutr/sqlite";
import {
  OperationJournalTable,
  type OperationRootPage,
  type RebaseJournalCursor,
} from "../operations/operation-journal.js";
import type {
  OperationHeader,
  OperationTouchedSource,
} from "../operations/operation-journal-types.js";
import type {
  CherryPickJournal,
  MergeJournal,
  MergeOperationJournal,
  MergeSavedIdentity,
  MergeStateMetadata,
  MergeTouchedPath,
  OperationJournal,
  OperationKind,
  OperationStateMetadata,
  OperationStepMetadata,
  RebaseJournal,
  RevertJournal,
} from "../operations/operations.js";

export class CheckoutOperationStore {
  readonly #table: OperationJournalTable;
  readonly #requireActive: () => void;

  constructor(
    database: SqlDatabase,
    repoId: number,
    checkoutId: number,
    requireActive: () => void,
  ) {
    this.#table = new OperationJournalTable(database, repoId, checkoutId);
    this.#requireActive = requireActive;
  }

  readOperationState(): OperationJournal | null {
    this.#requireActive();
    return this.#table.readOperationState();
  }

  readOperationHeaderOwned(): OperationHeader | null {
    this.#requireActive();
    return this.#table.readOperationHeader();
  }

  readOperationStepOwned(ordinal: number): OperationStepMetadata | null {
    this.#requireActive();
    return this.#table.readOperationStep(ordinal);
  }

  *iterateOperationTouchedOwned(): Generator<MergeTouchedPath> {
    this.#requireActive();
    for (const entry of this.#table.iterateOperationTouched()) {
      this.#requireActive();
      yield entry;
    }
  }

  readRebaseCursorOwned(): RebaseJournalCursor | null {
    this.#requireActive();
    return this.#table.readRebaseCursorOwned();
  }

  writeOperationStateOwned(state: OperationStateMetadata, touched: OperationTouchedSource): void {
    this.#requireActive();
    this.#table.writeOperationState(state, touched);
  }

  writeOperationJournalOwned(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: OperationTouchedSource,
  ): void {
    this.#requireActive();
    this.#table.writeOperationJournal(state, steps, touched);
  }

  markReplayEmptyOwned(kind: "cherry-pick" | "revert", reason: "source" | "result"): void {
    this.#requireActive();
    this.#table.markReplayEmpty(kind, reason);
  }

  suspendRebaseOwned(currentStep: number, touched: OperationTouchedSource): void {
    this.#requireActive();
    this.#table.suspendRebase(currentStep, touched);
  }

  advanceRebaseOwned(
    phase: "running" | "conflicted",
    currentStep: number,
    outcome: "applied" | "skipped",
    resultOid: string | null,
    currentParentOid: string,
    committer: MergeSavedIdentity | null,
  ): void {
    this.#requireActive();
    this.#table.advanceRebase(phase, currentStep, outcome, resultOid, currentParentOid, committer);
  }

  operationRootPage(cursor = 0, limit = 128): OperationRootPage {
    this.#requireActive();
    return this.#table.operationRootPage(cursor, limit);
  }

  clearOperationStateOwned(): boolean {
    this.#requireActive();
    return this.#table.clearOperationState();
  }

  requireNoOperationState(): void {
    this.#requireActive();
    this.#table.requireNoOperationState();
  }

  requireOperationState(kind: "merge"): MergeOperationJournal;
  requireOperationState(kind: "cherry-pick"): CherryPickJournal;
  requireOperationState(kind: "revert"): RevertJournal;
  requireOperationState(kind: "rebase"): RebaseJournal;
  requireOperationState(kind: OperationKind): OperationJournal;
  requireOperationState(kind: OperationKind): OperationJournal {
    this.#requireActive();
    return this.#table.requireOperationState(kind);
  }

  readMergeState(): MergeJournal | null {
    this.#requireActive();
    return this.#table.readMergeState();
  }

  writeMergeStateOwned(state: MergeStateMetadata, touched: OperationTouchedSource): void {
    this.#requireActive();
    this.#table.writeMergeState(state, touched);
  }

  clearMergeStateOwned(): boolean {
    this.#requireActive();
    return this.#table.clearMergeState();
  }

  requireNoMergeState(): void {
    this.#requireActive();
    this.#table.requireNoMergeState();
  }

  requireMergeState(): MergeJournal {
    this.#requireActive();
    return this.#table.requireMergeState();
  }
}
