import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../common/errors.js";
import { jsonPages } from "../core/json-pages.js";
import { bumpMaintenanceRootEpoch } from "../maintenance/control.js";
import { integrationJsonPages } from "./integration-workspace/storage.js";
import {
  persistedOperationStep,
  persistedOperationTouched,
  requireOperationKind,
} from "./operation-journal-rows.js";
import type {
  OperationTouchedSource,
  PersistedOperationStep,
  PersistedOperationTouched,
} from "./operation-journal-types.js";
import {
  MAX_OPERATION_STEPS,
  type MergeSavedIdentity,
  type OperationStateMetadata,
  type OperationStepMetadata,
  operationAlreadyActive,
  operationStepsForState,
} from "./operations.js";

// The ops layer validates caller input before it reaches these writers, and the
// schema CHECKs guard row shape; the journal is trusted from here on (ADR-0004).
export interface OperationJournalWriteContext {
  db: SqlDatabase;
  repoId: number;
  checkoutId: number;
}

export function writeOperationState(
  context: OperationJournalWriteContext,
  state: OperationStateMetadata,
  touched: OperationTouchedSource,
): void {
  if (state.kind === "rebase") {
    throw new CorruptError("rebase creation requires an explicit replay sequence");
  }
  writeOperationJournal(context, state, operationStepsForState(state), touched);
}

export function writeOperationJournal(
  context: OperationJournalWriteContext,
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: OperationTouchedSource,
): void {
  if (steps.length > MAX_OPERATION_STEPS) {
    throw new GitError("E2BIG", `operation journal exceeds ${MAX_OPERATION_STEPS} steps`);
  }
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
  context.db.transactionSync(() => {
    const active = context.db.one<{ kind: unknown }>(
      "SELECT kind FROM git_operation_state WHERE checkout_id = ?",
      context.checkoutId,
    );
    if (active !== undefined) throw operationAlreadyActive(requireOperationKind(active.kind));
    insertOperationHeader(context, state, steps.length, touched.length, replayed, skipped);
    insertOperationSteps(context, steps);
    replaceTouched(context, touched);
    bumpMaintenanceRootEpoch(context.db, context.repoId);
  });
}

function insertOperationHeader(
  context: OperationJournalWriteContext,
  state: OperationStateMetadata,
  stepCount: number,
  touchedCount: number,
  replayed: number,
  skipped: number,
): void {
  context.db.run(
    `INSERT INTO git_operation_state
       (checkout_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
        current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode, merge_origin,
        current_step, step_count, current_label, incoming_label, message,
        author_name, author_email, committer_name, committer_email, touched_count,
        replayed_count, skipped_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    context.checkoutId,
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

function insertOperationSteps(
  context: OperationJournalWriteContext,
  steps: readonly OperationStepMetadata[],
): void {
  function* rows(): Generator<PersistedOperationStep> {
    for (let ordinal = 0; ordinal < steps.length; ordinal++) {
      const step = steps[ordinal];
      if (step === undefined) throw new CorruptError("operation step sequence is sparse");
      yield persistedOperationStep(step, ordinal);
    }
  }
  for (const page of jsonPages(rows(), "operation step")) {
    context.db.run(
      `INSERT INTO git_operation_steps
         (checkout_id, ordinal, source_oid, selected_parent_oid, mainline, outcome, result_oid)
       SELECT ?, json_extract(value, '$.ordinal'), json_extract(value, '$.sourceOid'),
              json_extract(value, '$.selectedParentOid'), json_extract(value, '$.mainline'),
              json_extract(value, '$.outcome'), json_extract(value, '$.resultOid')
         FROM json_each(?) ORDER BY CAST(json_extract(value, '$.ordinal') AS INTEGER)`,
      context.checkoutId,
      page,
    );
  }
}

function replaceTouched(
  context: OperationJournalWriteContext,
  touched: OperationTouchedSource,
): void {
  context.db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", context.checkoutId);
  function* rows(): Generator<PersistedOperationTouched> {
    let ordinal = 0;
    for (const entry of touched) {
      yield persistedOperationTouched(entry, ordinal++);
    }
    if (ordinal !== touched.length)
      throw new CorruptError("operation touched count differs from its rows");
  }
  for (const page of integrationJsonPages(rows())) {
    context.db.run(
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
      context.checkoutId,
      page,
    );
  }
}

export function markReplayEmpty(
  context: OperationJournalWriteContext,
  kind: "cherry-pick" | "revert",
  reason: "source" | "result",
): void {
  context.db.transactionSync(() => {
    const changed = context.db.one<{ checkout_id: unknown }>(
      `UPDATE git_operation_state
          SET phase = 'empty', empty_reason = ?, touched_count = 0
        WHERE checkout_id = ? AND kind = ? AND phase = 'conflicted' AND current_step = 0
          AND EXISTS (
            SELECT 1 FROM git_operation_steps
             WHERE checkout_id = ? AND ordinal = 0 AND outcome = 'pending'
          )
      RETURNING checkout_id`,
      reason,
      context.checkoutId,
      kind,
      context.checkoutId,
    );
    if (changed === undefined) {
      throw new GitError("EOPMISMATCH", `${kind} operation changed before transition`);
    }
    context.db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", context.checkoutId);
    bumpMaintenanceRootEpoch(context.db, context.repoId);
  });
}

export function suspendRebase(
  context: OperationJournalWriteContext,
  currentStep: number,
  touched: OperationTouchedSource,
): void {
  if (touched.length === 0) throw new CorruptError("conflicted rebase lost its touched paths");
  context.db.transactionSync(() => {
    const changed = context.db.one<{ checkout_id: unknown }>(
      `UPDATE git_operation_state
          SET phase = 'conflicted', touched_count = ?
        WHERE checkout_id = ? AND kind = 'rebase' AND phase = 'running' AND current_step = ?
          AND EXISTS (
            SELECT 1 FROM git_operation_steps
             WHERE checkout_id = ? AND ordinal = ? AND outcome = 'pending'
          )
      RETURNING checkout_id`,
      touched.length,
      context.checkoutId,
      currentStep,
      context.checkoutId,
      currentStep,
    );
    if (changed === undefined) {
      throw new GitError("EOPMISMATCH", "rebase operation changed before suspension");
    }
    replaceTouched(context, touched);
    bumpMaintenanceRootEpoch(context.db, context.repoId);
  });
}

export function advanceRebase(
  context: OperationJournalWriteContext,
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
  context.db.transactionSync(() => {
    const changed = context.db.one<{ checkout_id: unknown }>(
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
      context.checkoutId,
      phase,
      currentStep,
      context.checkoutId,
      currentStep,
    );
    if (changed === undefined) {
      throw new GitError("EOPMISMATCH", "rebase operation changed before advancement");
    }
    const step = context.db.one<{ ordinal: unknown }>(
      `UPDATE git_operation_steps
          SET outcome = ?, result_oid = ?
        WHERE checkout_id = ? AND ordinal = ? AND outcome = 'pending'
      RETURNING ordinal`,
      outcome,
      resultOid,
      context.checkoutId,
      currentStep,
    );
    if (step === undefined) {
      throw new GitError("EOPMISMATCH", "rebase step changed before advancement");
    }
    context.db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", context.checkoutId);
    bumpMaintenanceRootEpoch(context.db, context.repoId);
  });
}

export function clearOperationState(context: OperationJournalWriteContext): boolean {
  return context.db.transactionSync(() => {
    const deleted = context.db.one<{ checkout_id: unknown }>(
      "DELETE FROM git_operation_state WHERE checkout_id = ? RETURNING checkout_id",
      context.checkoutId,
    );
    if (deleted !== undefined) bumpMaintenanceRootEpoch(context.db, context.repoId);
    return deleted !== undefined;
  });
}
