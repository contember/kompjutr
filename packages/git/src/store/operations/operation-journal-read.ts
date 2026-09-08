import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError } from "../../common/errors.js";
import {
  operationIdentityFromRow,
  operationJournal,
  operationMetadataFromRow,
  operationStepFromRow,
  operationTouchedFromRow,
  requireOperationKind,
} from "./operation-journal-rows.js";
import type {
  OperationStateRow,
  OperationStepRow,
  OperationTouchedRow,
  RebaseJournalCursor,
} from "./operation-journal-types.js";
import {
  type MergeTouchedPath,
  type OperationJournal,
  type OperationStepMetadata,
  operationKindMismatch,
  type RebaseStateMetadata,
  requireMergeInteger,
  requireMergeOid,
  requireMergeText,
} from "./operations.js";

export function readOperationState(db: SqlDatabase, checkoutId: number): OperationJournal | null {
  const row = db.one<OperationStateRow>(
    `SELECT kind, original_head_ref, original_head_oid, phase, empty_reason,
            current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode,
            merge_origin, current_step, step_count, current_label, incoming_label,
            message, author_name, author_email, committer_name, committer_email,
            touched_count, replayed_count, skipped_count
       FROM git_operation_state WHERE checkout_id = ?`,
    checkoutId,
  );
  if (row === undefined) return null;

  const steps: OperationStepMetadata[] = [];
  for (const raw of db.iterate(
    `SELECT ordinal, source_oid, selected_parent_oid, mainline, outcome, result_oid
       FROM git_operation_steps WHERE checkout_id = ? ORDER BY ordinal`,
    checkoutId,
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
  const touched = readTouched(db, checkoutId);
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

export function readRebaseCursor(db: SqlDatabase, checkoutId: number): RebaseJournalCursor | null {
  const row = db.one<OperationStateRow>(
    `SELECT kind, original_head_ref, original_head_oid, phase, empty_reason,
            current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode,
            merge_origin, current_step, step_count, current_label, incoming_label,
            message, author_name, author_email, committer_name, committer_email,
            touched_count, replayed_count, skipped_count
       FROM git_operation_state WHERE checkout_id = ?`,
    checkoutId,
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
    const raw = db.one<OperationStepRow>(
      `SELECT ordinal, source_oid, selected_parent_oid, mainline, outcome, result_oid
         FROM git_operation_steps WHERE checkout_id = ? AND ordinal = ?`,
      checkoutId,
      currentStep,
    );
    if (raw === undefined || requireMergeInteger(raw.ordinal, "step ordinal") !== currentStep) {
      throw new CorruptError("rebase current step row is missing");
    }
    step = operationStepFromRow(raw);
  } else if (currentStep !== stepCount) {
    throw new CorruptError("rebase cursor exceeds its step count");
  }
  const touched = readTouched(db, checkoutId);
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

function readTouched(db: SqlDatabase, checkoutId: number): MergeTouchedPath[] {
  const touched: MergeTouchedPath[] = [];
  for (const raw of db.iterate(
    `SELECT ordinal, path, logical_path, purpose, index_stage, index_mode, index_oid,
            index_size, index_mtime, index_ino, index_rev, worktree_kind, worktree_mode,
            worktree_oid, worktree_revision
       FROM git_operation_touched WHERE checkout_id = ? ORDER BY ordinal`,
    checkoutId,
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
  return touched;
}
