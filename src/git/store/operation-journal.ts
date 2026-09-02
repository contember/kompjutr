import type { SqlDatabase } from "../../db/db.js";
import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import type { RawObject } from "../common/objects.js";
import { comparePaths } from "../common/paths.js";
import { type CheckoutStore, checkoutStoreMutations } from "./checkout.js";
import { type CommitCacheEntry, prepareCommitCache } from "./commits.js";
import type { ObjectReadInfo } from "./contracts.js";
import { jsonPages } from "./json-pages.js";
import { bumpMaintenanceRootEpoch } from "./maintenance/control.js";
import { MAX_BLOB_BATCH_OIDS, type ObjectTable } from "./objects.js";
import {
  type CherryPickJournal,
  type MergeIndexSnapshot,
  type MergeJournal,
  type MergeOperationJournal,
  type MergeSavedIdentity,
  type MergeStateMetadata,
  type MergeTouchedPath,
  type MergeWorktreeSnapshot,
  mergeJournalFromOperation,
  mergeOperationState,
  type OperationJournal,
  type OperationKind,
  type OperationStateMetadata,
  type OperationStepMetadata,
  operationAlreadyActive,
  operationKindMismatch,
  operationNotActive,
  operationStepsForState,
  type RebaseJournal,
  type RebaseStateMetadata,
  type RevertJournal,
  requireMergeInteger,
  requireMergeMode,
  requireMergeNullableInteger,
  requireMergeOid,
  requireMergeOrigin,
  requireMergePhase,
  requireMergePurpose,
  requireMergeText,
  validateOperationJournal,
} from "./operations.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "./packs.js";

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

export interface OperationStateRow {
  kind: unknown;
  original_head_ref: unknown;
  original_head_oid: unknown;
  phase: unknown;
  empty_reason: unknown;
  current_parent_oid: unknown;
  incoming_parent_oid: unknown;
  upstream_oid: unknown;
  base_oid: unknown;
  mode: unknown;
  merge_origin: unknown;
  current_step: unknown;
  step_count: unknown;
  current_label: unknown;
  incoming_label: unknown;
  message: unknown;
  author_name: unknown;
  author_email: unknown;
  committer_name: unknown;
  committer_email: unknown;
  touched_count: unknown;
  replayed_count: unknown;
  skipped_count: unknown;
}

export interface OperationStepRow {
  ordinal: unknown;
  source_oid: unknown;
  selected_parent_oid: unknown;
  mainline: unknown;
  outcome: unknown;
  result_oid: unknown;
}

export interface OperationTouchedRow {
  ordinal: unknown;
  path: unknown;
  logical_path: unknown;
  purpose: unknown;
  index_stage: unknown;
  index_mode: unknown;
  index_oid: unknown;
  index_size: unknown;
  index_mtime: unknown;
  index_ino: unknown;
  index_rev: unknown;
  worktree_kind: unknown;
  worktree_mode: unknown;
  worktree_oid: unknown;
  worktree_revision: unknown;
}

export interface PersistedOperationTouched {
  ordinal: number;
  path: string;
  logicalPath: string;
  purpose: string;
  indexStage: number | null;
  indexMode: number | null;
  indexOid: string | null;
  indexSize: number | null;
  indexMtime: number | null;
  indexIno: number | null;
  indexRev: number | null;
  worktreeKind: string;
  worktreeMode: number | null;
  worktreeOid: string | null;
  worktreeRevision: number | null;
}

export interface PersistedOperationStep {
  ordinal: number;
  sourceOid: string;
  selectedParentOid: string | null;
  mainline: number | null;
  outcome: string;
  resultOid: string | null;
}

export interface ExpectedOperationObject {
  oid: string;
  type: "blob" | "commit";
  label: string;
}

export function operationIdentityFromRow(
  name: unknown,
  email: unknown,
  label: string,
): MergeSavedIdentity | null {
  if (name === null && email === null) return null;
  if (name === null || email === null) {
    throw new CorruptError(`operation ${label} identity row is incomplete`);
  }
  return {
    name: requireMergeText(name, `${label} name`),
    email: requireMergeText(email, `${label} email`),
  };
}

export function requireOperationKind(value: unknown): OperationKind {
  if (value === "merge" || value === "cherry-pick" || value === "revert" || value === "rebase") {
    return value;
  }
  throw new CorruptError("operation journal has an invalid kind");
}

export function requireNullableOperationOid(value: unknown, label: string): string | null {
  return value === null ? null : requireMergeOid(value, label);
}

export function requireNullableMainline(value: unknown): number | null {
  if (value === null) return null;
  const mainline = requireMergeInteger(value, "mainline");
  if (mainline === 0) throw new CorruptError("replay mainline is not positive");
  return mainline;
}

export function operationStepFromRow(row: OperationStepRow): OperationStepMetadata {
  const outcome = row.outcome;
  if (outcome !== "pending" && outcome !== "applied" && outcome !== "skipped") {
    throw new CorruptError("operation step row has an invalid outcome");
  }
  return {
    sourceOid: requireMergeOid(row.source_oid, "step source"),
    selectedParentOid: requireNullableOperationOid(row.selected_parent_oid, "step parent"),
    mainline: requireNullableMainline(row.mainline),
    outcome,
    resultOid: requireNullableOperationOid(row.result_oid, "step result"),
  };
}

export function operationMetadataFromRow(
  row: OperationStateRow,
  steps: readonly OperationStepMetadata[],
): OperationStateMetadata {
  const kind = requireOperationKind(row.kind);
  const currentStep = requireMergeInteger(row.current_step, "current step");
  const stepCount = requireMergeInteger(row.step_count, "step count");
  if (stepCount !== steps.length) {
    throw new CorruptError("operation step count does not match its rows");
  }
  const common = {
    originalHeadRef: requireMergeText(row.original_head_ref, "original HEAD ref"),
    originalHeadOid: requireMergeOid(row.original_head_oid, "original HEAD"),
    currentLabel: requireMergeText(row.current_label, "current label"),
    incomingLabel: requireMergeText(row.incoming_label, "incoming label"),
    message: requireMergeText(row.message, "message"),
    author: operationIdentityFromRow(row.author_name, row.author_email, "author"),
    committer: operationIdentityFromRow(row.committer_name, row.committer_email, "committer"),
  };
  if (kind === "merge") {
    if (
      row.empty_reason !== null ||
      row.upstream_oid !== null ||
      row.base_oid !== null ||
      currentStep !== 0 ||
      stepCount !== 0
    ) {
      throw new CorruptError("merge journal retained replay metadata");
    }
    return {
      kind,
      ...common,
      currentParentOid: requireMergeOid(row.current_parent_oid, "current parent"),
      incomingParentOid: requireMergeOid(row.incoming_parent_oid, "incoming parent"),
      phase: requireMergePhase(row.phase),
      mode: requireMergeMode(row.mode),
      mergeOrigin: requireMergeOrigin(row.merge_origin),
    };
  }
  if (kind === "rebase") {
    if (
      row.empty_reason !== null ||
      row.incoming_parent_oid !== null ||
      row.mode !== null ||
      row.merge_origin !== null
    ) {
      throw new CorruptError("rebase journal retained one-shot operation metadata");
    }
    const phase = row.phase;
    if (phase !== "running" && phase !== "conflicted") {
      throw new CorruptError("rebase journal has an invalid phase");
    }
    return {
      kind,
      ...common,
      phase,
      upstreamOid: requireMergeOid(row.upstream_oid, "upstream"),
      baseOid: requireMergeOid(row.base_oid, "base"),
      currentParentOid: requireMergeOid(row.current_parent_oid, "current parent"),
      currentStep,
    };
  }
  if (
    row.current_parent_oid !== null ||
    row.incoming_parent_oid !== null ||
    row.upstream_oid !== null ||
    row.base_oid !== null ||
    row.mode !== null ||
    row.merge_origin !== null ||
    currentStep !== 0 ||
    stepCount !== 1
  ) {
    throw new CorruptError("replay journal retained merge metadata");
  }
  const phase = row.phase;
  if (phase !== "conflicted" && phase !== "empty") {
    throw new CorruptError("replay journal has an invalid phase");
  }
  const emptyReason = row.empty_reason;
  if (emptyReason !== null && emptyReason !== "source" && emptyReason !== "result") {
    throw new CorruptError("replay journal has an invalid empty reason");
  }
  const step = steps[0];
  if (step === undefined) throw new CorruptError("one-commit replay journal lost its source step");
  return {
    kind,
    ...common,
    phase,
    emptyReason,
    sourceOid: step.sourceOid,
    selectedParentOid: step.selectedParentOid,
    mainline: step.mainline,
  };
}

export function operationJournal(
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
  replayed: number,
  skipped: number,
): OperationJournal {
  const fields = { steps, touched, replayed, skipped };
  if (state.kind === "merge") return { kind: state.kind, state, ...fields };
  if (state.kind === "cherry-pick") return { kind: state.kind, state, ...fields };
  if (state.kind === "revert") return { kind: state.kind, state, ...fields };
  return { kind: state.kind, state, ...fields };
}

export function operationIndexFromRow(row: OperationTouchedRow): MergeIndexSnapshot | null {
  const values = [
    row.index_stage,
    row.index_mode,
    row.index_oid,
    row.index_size,
    row.index_mtime,
    row.index_ino,
    row.index_rev,
  ];
  if (values.every((value) => value === null)) return null;
  if (row.index_stage !== 0) throw new CorruptError("merge index snapshot has an invalid stage");
  return {
    stage: 0,
    mode: requireMergeInteger(row.index_mode, "index mode"),
    oid: requireMergeOid(row.index_oid, "index oid"),
    size: requireMergeNullableInteger(row.index_size, "index size"),
    mtime: requireMergeNullableInteger(row.index_mtime, "index mtime"),
    ino: requireMergeNullableInteger(row.index_ino, "index inode"),
    rev: requireMergeNullableInteger(row.index_rev, "index revision"),
  };
}

export function operationWorktreeFromRow(row: OperationTouchedRow): MergeWorktreeSnapshot {
  const kind = requireMergeText(row.worktree_kind, "worktree kind");
  if (kind === "absent") {
    if (row.worktree_mode !== null || row.worktree_oid !== null || row.worktree_revision !== null) {
      throw new CorruptError("absent merge worktree snapshot retained metadata");
    }
    return { kind };
  }
  const mode = requireMergeInteger(row.worktree_mode, "worktree mode");
  const revision = requireMergeInteger(row.worktree_revision, "worktree revision");
  if (kind === "directory") {
    if (row.worktree_oid !== null) {
      throw new CorruptError("merge directory snapshot retained an object id");
    }
    return { kind, mode, revision };
  }
  if (kind === "file" || kind === "symlink") {
    return { kind, mode, oid: requireMergeOid(row.worktree_oid, "worktree oid"), revision };
  }
  throw new CorruptError("merge journal has an invalid worktree kind");
}

export function operationTouchedFromRow(row: OperationTouchedRow): MergeTouchedPath {
  return {
    path: requireMergeText(row.path, "touched path"),
    logicalPath: requireMergeText(row.logical_path, "logical path"),
    purpose: requireMergePurpose(row.purpose),
    index: operationIndexFromRow(row),
    worktree: operationWorktreeFromRow(row),
  };
}

export function persistedOperationTouched(
  entry: MergeTouchedPath,
  ordinal: number,
): PersistedOperationTouched {
  const index = entry.index;
  const worktree = entry.worktree;
  return {
    ordinal,
    path: entry.path,
    logicalPath: entry.logicalPath,
    purpose: entry.purpose,
    indexStage: index?.stage ?? null,
    indexMode: index?.mode ?? null,
    indexOid: index?.oid ?? null,
    indexSize: index?.size ?? null,
    indexMtime: index?.mtime ?? null,
    indexIno: index?.ino ?? null,
    indexRev: index?.rev ?? null,
    worktreeKind: worktree.kind,
    worktreeMode: worktree.kind === "absent" ? null : worktree.mode,
    worktreeOid: worktree.kind === "file" || worktree.kind === "symlink" ? worktree.oid : null,
    worktreeRevision: worktree.kind === "absent" ? null : worktree.revision,
  };
}

export function persistedOperationStep(
  step: OperationStepMetadata,
  ordinal: number,
): PersistedOperationStep {
  return {
    ordinal,
    sourceOid: step.sourceOid,
    selectedParentOid: step.selectedParentOid,
    mainline: step.mainline,
    outcome: step.outcome,
    resultOid: step.resultOid,
  };
}

export interface OperationRootPage {
  roots: readonly ExpectedOperationObject[];
  nextCursor: number | null;
}

export interface RebaseJournalCursor {
  state: RebaseStateMetadata;
  stepCount: number;
  step: OperationStepMetadata | null;
  touched: readonly MergeTouchedPath[];
  replayed: number;
  skipped: number;
}

interface OperationRootRow {
  oid: unknown;
  expected_type: unknown;
}

interface RebaseTransitionRow {
  phase: unknown;
  current_step: unknown;
  current_parent_oid: unknown;
}

export class OperationJournalTable {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly checkoutId: number,
    private readonly objects: ObjectTable,
  ) {}

  readOperationState(): OperationJournal | null {
    const row = this.db.one<OperationStateRow>(
      `SELECT kind, original_head_ref, original_head_oid, phase, empty_reason,
              current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode,
              merge_origin, current_step, step_count, current_label, incoming_label,
              message, author_name, author_email, committer_name, committer_email,
              touched_count, replayed_count, skipped_count
         FROM git_operation_state WHERE checkout_id = ?`,
      this.checkoutId,
    );
    if (row === undefined) return null;

    const steps: OperationStepMetadata[] = [];
    for (const raw of this.db.iterate(
      `SELECT ordinal, source_oid, selected_parent_oid, mainline, outcome, result_oid
         FROM git_operation_steps WHERE checkout_id = ? ORDER BY ordinal`,
      this.checkoutId,
    )) {
      const stepRow: OperationStepRow = {
        ordinal: raw.ordinal,
        source_oid: raw.source_oid,
        selected_parent_oid: raw.selected_parent_oid,
        mainline: raw.mainline,
        outcome: raw.outcome,
        result_oid: raw.result_oid,
      };
      steps.push(operationStepFromRow(stepRow));
    }
    const state = operationMetadataFromRow(row, steps);
    const touched: MergeTouchedPath[] = [];
    for (const raw of this.db.iterate(
      `SELECT ordinal, path, logical_path, purpose, index_stage, index_mode, index_oid,
              index_size, index_mtime, index_ino, index_rev, worktree_kind, worktree_mode,
              worktree_oid, worktree_revision
         FROM git_operation_touched WHERE checkout_id = ? ORDER BY ordinal`,
      this.checkoutId,
    )) {
      const touchedRow: OperationTouchedRow = {
        ordinal: raw.ordinal,
        path: raw.path,
        logical_path: raw.logical_path,
        purpose: raw.purpose,
        index_stage: raw.index_stage,
        index_mode: raw.index_mode,
        index_oid: raw.index_oid,
        index_size: raw.index_size,
        index_mtime: raw.index_mtime,
        index_ino: raw.index_ino,
        index_rev: raw.index_rev,
        worktree_kind: raw.worktree_kind,
        worktree_mode: raw.worktree_mode,
        worktree_oid: raw.worktree_oid,
        worktree_revision: raw.worktree_revision,
      };
      touched.push(operationTouchedFromRow(touchedRow));
    }
    const touchedCount = requireMergeInteger(row.touched_count, "touched-path count");
    if (touched.length !== touchedCount) {
      throw new CorruptError("operation touched-path count does not match its rows");
    }
    return operationJournal(
      state,
      steps,
      touched,
      requireMergeInteger(row.replayed_count, "replayed count"),
      requireMergeInteger(row.skipped_count, "skipped count"),
    );
  }

  readRebaseCursorOwned(): RebaseJournalCursor | null {
    const row = this.db.one<OperationStateRow>(
      `SELECT kind, original_head_ref, original_head_oid, phase, empty_reason,
              current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode,
              merge_origin, current_step, step_count, current_label, incoming_label,
              message, author_name, author_email, committer_name, committer_email,
              touched_count, replayed_count, skipped_count
         FROM git_operation_state WHERE checkout_id = ?`,
      this.checkoutId,
    );
    if (row === undefined) return null;
    const kind = requireOperationKind(row.kind);
    if (kind !== "rebase") throw operationKindMismatch("rebase", kind);
    const currentStep = requireMergeInteger(row.current_step, "current step");
    const stepCount = requireMergeInteger(row.step_count, "step count");
    const phase = row.phase;
    if (phase !== "running" && phase !== "conflicted") {
      throw new CorruptError("rebase journal has an invalid phase");
    }
    if (
      row.empty_reason !== null ||
      row.incoming_parent_oid !== null ||
      row.mode !== null ||
      row.merge_origin !== null
    ) {
      throw new CorruptError("rebase journal retained one-shot operation metadata");
    }
    const state: RebaseStateMetadata = {
      kind,
      phase,
      originalHeadRef: requireMergeText(row.original_head_ref, "original HEAD ref"),
      originalHeadOid: requireMergeOid(row.original_head_oid, "original HEAD"),
      upstreamOid: requireMergeOid(row.upstream_oid, "upstream"),
      baseOid: requireMergeOid(row.base_oid, "base"),
      currentParentOid: requireMergeOid(row.current_parent_oid, "current parent"),
      currentStep,
      currentLabel: requireMergeText(row.current_label, "current label"),
      incomingLabel: requireMergeText(row.incoming_label, "incoming label"),
      message: requireMergeText(row.message, "message"),
      author: operationIdentityFromRow(row.author_name, row.author_email, "author"),
      committer: operationIdentityFromRow(row.committer_name, row.committer_email, "committer"),
    };
    let step: OperationStepMetadata | null = null;
    if (currentStep < stepCount) {
      const raw = this.db.one<OperationStepRow>(
        `SELECT ordinal, source_oid, selected_parent_oid, mainline, outcome, result_oid
           FROM git_operation_steps WHERE checkout_id = ? AND ordinal = ?`,
        this.checkoutId,
        currentStep,
      );
      if (raw === undefined || requireMergeInteger(raw.ordinal, "step ordinal") !== currentStep) {
        throw new CorruptError("rebase current step row is missing");
      }
      step = operationStepFromRow(raw);
    } else if (currentStep !== stepCount) {
      throw new CorruptError("rebase cursor exceeds its step count");
    }
    const touched: MergeTouchedPath[] = [];
    for (const raw of this.db.iterate(
      `SELECT ordinal, path, logical_path, purpose, index_stage, index_mode, index_oid,
              index_size, index_mtime, index_ino, index_rev, worktree_kind, worktree_mode,
              worktree_oid, worktree_revision
         FROM git_operation_touched WHERE checkout_id = ? ORDER BY ordinal`,
      this.checkoutId,
    )) {
      touched.push(
        operationTouchedFromRow({
          ordinal: raw.ordinal,
          path: raw.path,
          logical_path: raw.logical_path,
          purpose: raw.purpose,
          index_stage: raw.index_stage,
          index_mode: raw.index_mode,
          index_oid: raw.index_oid,
          index_size: raw.index_size,
          index_mtime: raw.index_mtime,
          index_ino: raw.index_ino,
          index_rev: raw.index_rev,
          worktree_kind: raw.worktree_kind,
          worktree_mode: raw.worktree_mode,
          worktree_oid: raw.worktree_oid,
          worktree_revision: raw.worktree_revision,
        }),
      );
    }
    const touchedCount = requireMergeInteger(row.touched_count, "touched-path count");
    if (touched.length !== touchedCount) {
      throw new CorruptError("operation touched-path count does not match its rows");
    }
    return {
      state,
      stepCount,
      step,
      touched,
      replayed: requireMergeInteger(row.replayed_count, "replayed count"),
      skipped: requireMergeInteger(row.skipped_count, "skipped count"),
    };
  }

  writeOperationState(state: OperationStateMetadata, touched: readonly MergeTouchedPath[]): void {
    if (state.kind === "rebase") {
      throw new CorruptError("rebase creation requires an explicit replay sequence");
    }
    this.writeOperationJournal(state, operationStepsForState(state), touched);
  }

  writeOperationJournal(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    validateOperationJournal(state, touched, steps);
    let replayed = 0;
    let skipped = 0;
    if (state.kind === "rebase") {
      for (let ordinal = 0; ordinal < state.currentStep; ordinal++) {
        const step = steps[ordinal];
        if (step === undefined) throw new CorruptError("rebase completed prefix is sparse");
        if (step.outcome === "applied") replayed++;
        if (step.outcome === "skipped") skipped++;
      }
    }
    this.db.transactionSync(() => {
      const active = this.db.one<{ kind: unknown }>(
        "SELECT kind FROM git_operation_state WHERE checkout_id = ?",
        this.checkoutId,
      );
      if (active !== undefined) throw operationAlreadyActive(requireOperationKind(active.kind));
      const journal = operationJournal(state, steps, touched, replayed, skipped);
      this.#validateOperationObjects(journal);
      this.#insertOperationHeader(state, steps.length, touched.length, replayed, skipped);
      this.#insertOperationSteps(steps);
      this.#replaceTouched(touched);
      bumpMaintenanceRootEpoch(this.db, this.repoId);
    });
  }

  #insertOperationHeader(
    state: OperationStateMetadata,
    stepCount: number,
    touchedCount: number,
    replayed: number,
    skipped: number,
  ): void {
    this.db.run(
      `INSERT INTO git_operation_state
         (checkout_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
          current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode, merge_origin,
          current_step, step_count, current_label, incoming_label, message,
          author_name, author_email, committer_name, committer_email, touched_count,
          replayed_count, skipped_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.checkoutId,
      state.kind,
      state.originalHeadRef,
      state.originalHeadOid,
      state.phase,
      state.kind === "cherry-pick" || state.kind === "revert" ? state.emptyReason : null,
      state.kind === "merge" || state.kind === "rebase" ? state.currentParentOid : null,
      state.kind === "merge" ? state.incomingParentOid : null,
      state.kind === "rebase" ? state.upstreamOid : null,
      state.kind === "rebase" ? state.baseOid : null,
      state.kind === "merge" ? state.mode : null,
      state.kind === "merge" ? state.mergeOrigin : null,
      state.kind === "rebase" ? state.currentStep : 0,
      stepCount,
      state.currentLabel,
      state.incomingLabel,
      state.message,
      state.author?.name ?? null,
      state.author?.email ?? null,
      state.committer?.name ?? null,
      state.committer?.email ?? null,
      touchedCount,
      replayed,
      skipped,
    );
  }

  #insertOperationSteps(steps: readonly OperationStepMetadata[]): void {
    function* rows(): Generator<PersistedOperationStep> {
      for (let ordinal = 0; ordinal < steps.length; ordinal++) {
        const step = steps[ordinal];
        if (step === undefined) throw new CorruptError("operation step sequence is sparse");
        yield persistedOperationStep(step, ordinal);
      }
    }
    for (const page of jsonPages(rows(), "operation step")) {
      this.db.run(
        `INSERT INTO git_operation_steps
           (checkout_id, ordinal, source_oid, selected_parent_oid, mainline, outcome, result_oid)
         SELECT ?, json_extract(value, '$.ordinal'), json_extract(value, '$.sourceOid'),
                json_extract(value, '$.selectedParentOid'), json_extract(value, '$.mainline'),
                json_extract(value, '$.outcome'), json_extract(value, '$.resultOid')
           FROM json_each(?) ORDER BY CAST(json_extract(value, '$.ordinal') AS INTEGER)`,
        this.checkoutId,
        page,
      );
    }
  }

  #replaceTouched(touched: readonly MergeTouchedPath[]): void {
    let previousPath: string | null = null;
    for (const entry of touched) {
      if (previousPath !== null && comparePaths(previousPath, entry.path) >= 0) {
        throw new CorruptError("operation touched paths are not in strict Git path order");
      }
      previousPath = entry.path;
    }
    this.db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", this.checkoutId);
    function* rows(): Generator<PersistedOperationTouched> {
      for (let ordinal = 0; ordinal < touched.length; ordinal++) {
        const entry = touched[ordinal];
        if (entry === undefined) throw new CorruptError("operation touched sequence is sparse");
        yield persistedOperationTouched(entry, ordinal);
      }
    }
    for (const page of jsonPages(rows(), "operation touched path")) {
      this.db.run(
        `INSERT INTO git_operation_touched
           (checkout_id, ordinal, path, logical_path, purpose, index_stage, index_mode,
            index_oid, index_size, index_mtime, index_ino, index_rev, worktree_kind,
            worktree_mode, worktree_oid, worktree_revision)
         SELECT ?, json_extract(value, '$.ordinal'), json_extract(value, '$.path'),
                json_extract(value, '$.logicalPath'), json_extract(value, '$.purpose'),
                json_extract(value, '$.indexStage'), json_extract(value, '$.indexMode'),
                json_extract(value, '$.indexOid'), json_extract(value, '$.indexSize'),
                json_extract(value, '$.indexMtime'), json_extract(value, '$.indexIno'),
                json_extract(value, '$.indexRev'), json_extract(value, '$.worktreeKind'),
                json_extract(value, '$.worktreeMode'), json_extract(value, '$.worktreeOid'),
                json_extract(value, '$.worktreeRevision')
           FROM json_each(?) ORDER BY CAST(json_extract(value, '$.ordinal') AS INTEGER)`,
        this.checkoutId,
        page,
      );
    }
  }

  markReplayEmpty(kind: "cherry-pick" | "revert", reason: "source" | "result"): void {
    this.db.transactionSync(() => {
      const changed = this.db.one<{ checkout_id: unknown }>(
        `UPDATE git_operation_state
            SET phase = 'empty', empty_reason = ?, touched_count = 0
          WHERE checkout_id = ? AND kind = ? AND phase = 'conflicted' AND current_step = 0
            AND EXISTS (
              SELECT 1 FROM git_operation_steps
               WHERE checkout_id = ? AND ordinal = 0 AND outcome = 'pending'
            )
        RETURNING checkout_id`,
        reason,
        this.checkoutId,
        kind,
        this.checkoutId,
      );
      if (changed === undefined) {
        throw new GitError("EOPMISMATCH", `${kind} operation changed before transition`);
      }
      this.db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", this.checkoutId);
      bumpMaintenanceRootEpoch(this.db, this.repoId);
    });
  }

  suspendRebase(currentStep: number, touched: readonly MergeTouchedPath[]): void {
    if (touched.length === 0) throw new CorruptError("conflicted rebase lost its touched paths");
    this.db.transactionSync(() => {
      const changed = this.db.one<{ checkout_id: unknown }>(
        `UPDATE git_operation_state
            SET phase = 'conflicted', touched_count = ?
          WHERE checkout_id = ? AND kind = 'rebase' AND phase = 'running' AND current_step = ?
            AND EXISTS (
              SELECT 1 FROM git_operation_steps
               WHERE checkout_id = ? AND ordinal = ? AND outcome = 'pending'
            )
        RETURNING checkout_id`,
        touched.length,
        this.checkoutId,
        currentStep,
        this.checkoutId,
        currentStep,
      );
      if (changed === undefined) {
        throw new GitError("EOPMISMATCH", "rebase operation changed before suspension");
      }
      this.#replaceTouched(touched);
      bumpMaintenanceRootEpoch(this.db, this.repoId);
    });
  }

  advanceRebase(
    phase: "running" | "conflicted",
    currentStep: number,
    outcome: "applied" | "skipped",
    resultOid: string | null,
    currentParentOid: string,
    committer: MergeSavedIdentity | null,
  ): void {
    if ((outcome === "applied") !== (resultOid !== null)) {
      throw new CorruptError("rebase result does not match its outcome");
    }
    this.db.transactionSync(() => {
      const current = this.db.one<RebaseTransitionRow>(
        `SELECT phase, current_step, current_parent_oid
           FROM git_operation_state WHERE checkout_id = ? AND kind = 'rebase'`,
        this.checkoutId,
      );
      if (
        current === undefined ||
        current.phase !== phase ||
        requireMergeInteger(current.current_step, "current step") !== currentStep
      ) {
        throw new GitError("EOPMISMATCH", "rebase operation changed before advancement");
      }
      const previousParent = requireMergeOid(current.current_parent_oid, "current parent");
      if (outcome === "applied") {
        if (resultOid === null) throw new CorruptError("applied rebase step lost its result");
        if (currentParentOid !== resultOid) {
          throw new CorruptError("applied rebase parent differs from its result");
        }
        this.#validateResultCommit(resultOid, previousParent);
      } else if (currentParentOid !== previousParent) {
        throw new CorruptError("skipped rebase step changed the current parent");
      }
      const changed = this.db.one<{ checkout_id: unknown }>(
        `UPDATE git_operation_state
            SET phase = 'running', current_step = current_step + 1, current_parent_oid = ?,
                committer_name = ?, committer_email = ?, touched_count = 0,
                replayed_count = replayed_count + CASE WHEN ? = 'applied' THEN 1 ELSE 0 END,
                skipped_count = skipped_count + CASE WHEN ? = 'skipped' THEN 1 ELSE 0 END
          WHERE checkout_id = ? AND kind = 'rebase' AND phase = ? AND current_step = ?
            AND EXISTS (
              SELECT 1 FROM git_operation_steps
               WHERE checkout_id = ? AND ordinal = ? AND outcome = 'pending'
            )
        RETURNING checkout_id`,
        currentParentOid,
        committer?.name ?? null,
        committer?.email ?? null,
        outcome,
        outcome,
        this.checkoutId,
        phase,
        currentStep,
        this.checkoutId,
        currentStep,
      );
      if (changed === undefined) {
        throw new GitError("EOPMISMATCH", "rebase operation changed before advancement");
      }
      const step = this.db.one<{ ordinal: unknown }>(
        `UPDATE git_operation_steps
            SET outcome = ?, result_oid = ?
          WHERE checkout_id = ? AND ordinal = ? AND outcome = 'pending'
        RETURNING ordinal`,
        outcome,
        resultOid,
        this.checkoutId,
        currentStep,
      );
      if (step === undefined) {
        throw new GitError("EOPMISMATCH", "rebase step changed before advancement");
      }
      this.db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", this.checkoutId);
      bumpMaintenanceRootEpoch(this.db, this.repoId);
    });
  }

  #validateResultCommit(resultOid: string, expectedParent: string): void {
    let object: RawObject | undefined;
    try {
      const batch = this.objects.readObjects([resultOid], {
        budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES,
      });
      object = batch.objects.get(resultOid);
    } catch (error) {
      if (hasErrorCode(error, "ENOTFOUND")) {
        throw new CorruptError("operation result references a missing object", { cause: error });
      }
      throw error;
    }
    if (object === undefined || object.type !== "commit") {
      throw new CorruptError("operation result is not a complete commit");
    }
    const result = prepareCommitCache({ repoId: this.repoId, oid: resultOid, data: object.data });
    if (result.commit.parent.length !== 1 || result.commit.parent[0] !== expectedParent) {
      throw new CorruptError("operation result has an invalid replay parent");
    }
  }

  #validateOperationObjects(journal: OperationJournal): void {
    const expected = new Map<string, ExpectedOperationObject>();
    const objectSizes = new Map<string, number>();
    const add = (object: ExpectedOperationObject): void => {
      const previous = expected.get(object.oid);
      if (previous !== undefined && previous.type !== object.type) {
        throw new CorruptError(
          `operation journal object ${object.oid} has conflicting expected types`,
        );
      }
      if (previous === undefined) expected.set(object.oid, object);
    };
    add({ oid: journal.state.originalHeadOid, type: "commit", label: "original HEAD" });
    if (journal.state.kind === "merge") {
      add({ oid: journal.state.currentParentOid, type: "commit", label: "current parent" });
      add({ oid: journal.state.incomingParentOid, type: "commit", label: "incoming parent" });
    } else if (journal.state.kind === "rebase") {
      add({ oid: journal.state.upstreamOid, type: "commit", label: "upstream" });
      add({ oid: journal.state.baseOid, type: "commit", label: "base" });
      add({ oid: journal.state.currentParentOid, type: "commit", label: "current parent" });
    }
    for (const step of journal.steps) {
      add({ oid: step.sourceOid, type: "commit", label: "step source" });
      if (step.selectedParentOid !== null) {
        add({ oid: step.selectedParentOid, type: "commit", label: "step selected parent" });
      }
      if (step.resultOid !== null) {
        add({ oid: step.resultOid, type: "commit", label: "step result" });
      }
    }
    for (const entry of journal.touched) {
      if (entry.index !== null) {
        add({
          oid: entry.index.oid,
          type: entry.index.mode === 0o160000 ? "commit" : "blob",
          label: `saved index path ${entry.path}`,
        });
      }
      if (entry.worktree.kind === "file" || entry.worktree.kind === "symlink") {
        add({
          oid: entry.worktree.oid,
          type: "blob",
          label: `saved worktree path ${entry.path}`,
        });
      }
    }
    for (const page of this.#objectPages(expected.keys())) {
      let info: ObjectReadInfo[];
      try {
        info = this.objects.objectInfo(page);
      } catch (error) {
        if (hasErrorCode(error, "ENOTFOUND")) {
          throw new CorruptError("operation journal references a missing object", { cause: error });
        }
        throw error;
      }
      for (const object of info) {
        const wanted = expected.get(object.oid);
        if (wanted === undefined || object.type !== wanted.type) {
          throw new CorruptError(
            `operation ${wanted?.label ?? "journal"} references ${object.type} object ${object.oid}`,
          );
        }
        objectSizes.set(object.oid, object.size);
      }
    }
    if (journal.kind !== "merge") this.#validateReplayTopology(journal, objectSizes);
  }

  *#objectPages(oids: Iterable<string>): Generator<string[]> {
    let page: string[] = [];
    for (const oid of oids) {
      page.push(oid);
      if (page.length === MAX_BLOB_BATCH_OIDS) {
        yield page;
        page = [];
      }
    }
    if (page.length > 0) yield page;
  }

  #validateReplayTopology(
    journal: CherryPickJournal | RevertJournal | RebaseJournal,
    objectSizes: ReadonlyMap<string, number>,
  ): void {
    if (journal.kind !== "rebase") {
      const step = journal.steps[0];
      if (step === undefined) throw new CorruptError("one-commit replay lost its source step");
      this.#validateOperationCommitBodies(
        [step.sourceOid],
        (_oid, source) => this.#validateReplayParentSelection(step, source.commit.parent),
        objectSizes,
      );
      return;
    }
    let expectedSourceParent = journal.state.baseOid;
    let sourceOrdinal = 0;
    this.#validateOperationCommitBodies(
      journal.steps.map((step) => step.sourceOid),
      (_oid, source) => {
        const step = journal.steps[sourceOrdinal++];
        if (
          step === undefined ||
          source.commit.parent.length !== 1 ||
          source.commit.parent[0] !== expectedSourceParent ||
          step.selectedParentOid !== expectedSourceParent ||
          step.mainline !== null
        ) {
          throw new CorruptError("rebase source steps are not an oldest-first linear sequence");
        }
        expectedSourceParent = step.sourceOid;
      },
      objectSizes,
    );
    if (expectedSourceParent !== journal.state.originalHeadOid) {
      throw new CorruptError("rebase source sequence does not end at the original HEAD");
    }
    let expectedResultParent = journal.state.upstreamOid;
    for (let ordinal = 0; ordinal < journal.state.currentStep; ordinal++) {
      const step = journal.steps[ordinal];
      if (step === undefined) throw new CorruptError("rebase completed prefix is sparse");
      if (step.outcome === "applied") {
        if (step.resultOid === null) throw new CorruptError("applied rebase step lost its result");
        this.#validateResultCommit(step.resultOid, expectedResultParent);
        expectedResultParent = step.resultOid;
      }
    }
    if (expectedResultParent !== journal.state.currentParentOid) {
      throw new CorruptError("rebase result sequence differs from the current parent");
    }
  }

  #validateOperationCommitBodies(
    oids: readonly string[],
    visit: (oid: string, commit: CommitCacheEntry) => void,
    objectSizes: ReadonlyMap<string, number>,
  ): void {
    const seen = new Set<string>();
    for (let offset = 0; offset < oids.length; offset += MAX_BLOB_BATCH_OIDS) {
      let remaining = oids.slice(offset, offset + MAX_BLOB_BATCH_OIDS);
      for (const oid of remaining) {
        if (seen.has(oid)) throw new CorruptError("operation commit sequence contains a cycle");
        seen.add(oid);
        if (objectSizes.get(oid) === undefined) {
          throw new CorruptError(`operation commit ${oid} lost its validated size`);
        }
      }
      while (remaining.length > 0) {
        const batch = this.objects.readObjects(remaining, {
          budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES,
        });
        if (batch.objects.size === 0 || batch.bytes <= 0) {
          throw new CorruptError("operation commit validation made no progress");
        }
        for (const [oid, object] of batch.objects) {
          if (object.type !== "commit") {
            throw new CorruptError("operation step did not produce a complete commit object");
          }
          visit(oid, prepareCommitCache({ repoId: this.repoId, oid, data: object.data }));
        }
        remaining = batch.remaining;
      }
    }
  }

  #validateReplayParentSelection(step: OperationStepMetadata, parents: readonly string[]): void {
    if (parents.length === 0) {
      if (step.selectedParentOid !== null || step.mainline !== null) {
        throw new CorruptError("root replay source retained a selected parent or mainline");
      }
      return;
    }
    if (parents.length === 1) {
      if (
        step.selectedParentOid !== parents[0] ||
        (step.mainline !== null && step.mainline !== 1)
      ) {
        throw new CorruptError("single-parent replay selection differs from its source commit");
      }
      return;
    }
    if (
      step.mainline === null ||
      step.mainline > parents.length ||
      step.selectedParentOid !== parents[step.mainline - 1]
    ) {
      throw new CorruptError("merge replay selection differs from its source commit");
    }
  }

  clearOperationState(): boolean {
    return this.db.transactionSync(() => {
      const deleted = this.db.one<{ checkout_id: unknown }>(
        "DELETE FROM git_operation_state WHERE checkout_id = ? RETURNING checkout_id",
        this.checkoutId,
      );
      if (deleted !== undefined) bumpMaintenanceRootEpoch(this.db, this.repoId);
      return deleted !== undefined;
    });
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
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new GitError("EINVAL", "operation root cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new GitError("EINVAL", "operation root page limit must be between 1 and 256");
    }
    const roots: ExpectedOperationObject[] = [];
    for (const raw of this.db.iterate(
      `SELECT oid, expected_type FROM (
         SELECT original_head_oid AS oid, 'commit' AS expected_type, 0 AS family, 0 AS ordinal
           FROM git_operation_state WHERE checkout_id = ?
         UNION ALL
         SELECT current_parent_oid, 'commit', 0, 1 FROM git_operation_state
           WHERE checkout_id = ? AND current_parent_oid IS NOT NULL
         UNION ALL
         SELECT incoming_parent_oid, 'commit', 0, 2 FROM git_operation_state
           WHERE checkout_id = ? AND incoming_parent_oid IS NOT NULL
         UNION ALL
         SELECT upstream_oid, 'commit', 0, 3 FROM git_operation_state
           WHERE checkout_id = ? AND upstream_oid IS NOT NULL
         UNION ALL
         SELECT base_oid, 'commit', 0, 4 FROM git_operation_state
           WHERE checkout_id = ? AND base_oid IS NOT NULL
         UNION ALL
         SELECT source_oid, 'commit', 1, ordinal * 3 FROM git_operation_steps
           WHERE checkout_id = ?
         UNION ALL
         SELECT selected_parent_oid, 'commit', 1, ordinal * 3 + 1 FROM git_operation_steps
           WHERE checkout_id = ? AND selected_parent_oid IS NOT NULL
         UNION ALL
         SELECT result_oid, 'commit', 1, ordinal * 3 + 2 FROM git_operation_steps
           WHERE checkout_id = ? AND result_oid IS NOT NULL
         UNION ALL
         SELECT index_oid, CASE WHEN index_mode = 57344 THEN 'commit' ELSE 'blob' END,
                2, ordinal * 2
           FROM git_operation_touched WHERE checkout_id = ? AND index_oid IS NOT NULL
         UNION ALL
         SELECT worktree_oid, 'blob', 2, ordinal * 2 + 1 FROM git_operation_touched
           WHERE checkout_id = ? AND worktree_oid IS NOT NULL
       ) ORDER BY family, ordinal LIMIT ? OFFSET ?`,
      this.checkoutId,
      this.checkoutId,
      this.checkoutId,
      this.checkoutId,
      this.checkoutId,
      this.checkoutId,
      this.checkoutId,
      this.checkoutId,
      this.checkoutId,
      this.checkoutId,
      limit + 1,
      cursor,
    )) {
      const row: OperationRootRow = { oid: raw.oid, expected_type: raw.expected_type };
      if (roots.length === limit) {
        return { roots, nextCursor: cursor + limit };
      }
      const type = row.expected_type;
      if (type !== "blob" && type !== "commit") {
        throw new CorruptError("operation root has an invalid expected type");
      }
      roots.push({
        oid: requireMergeOid(row.oid, "operation root"),
        type,
        label: "operation root",
      });
    }
    return { roots, nextCursor: null };
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
}
