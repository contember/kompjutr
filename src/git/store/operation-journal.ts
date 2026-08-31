import type { SqlDatabase } from "../../db/db.js";
import { isOid } from "../common/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import { type CommitCacheEntry, prepareCommitCache } from "./commits.js";
import type { ObjectReadInfo } from "./contracts.js";
import { jsonPages, requireBooleanProbe } from "./json-pages.js";
import { bumpMaintenanceRootEpoch } from "./maintenance/control.js";
import { MAX_BLOB_BATCH_OIDS, type ObjectTable } from "./objects.js";
import {
  type CherryPickJournal,
  MAX_MERGE_IDENTITY_BYTES,
  MAX_MERGE_LABEL_BYTES,
  MAX_MERGE_MESSAGE_BYTES,
  MAX_MERGE_PATH_BYTES,
  MAX_MERGE_REF_BYTES,
  MAX_MERGE_TOUCHED_PATHS,
  MAX_OPERATION_STEPS,
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
  operationJournalIntegrityOid,
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
} from "./operations.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "./packs.js";

export interface OperationJournalOwner {
  readOperationStateOwned(): OperationJournal | null;
  writeOperationJournalOwned(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void;
  replaceOperationStateOwned(expectedIntegrityOid: string, state: OperationStateMetadata): void;
  replaceOperationJournalOwned(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void;
}

export function readOperationStateOwned(store: OperationJournalOwner): OperationJournal | null {
  return store.readOperationStateOwned();
}

export function writeOperationJournalOwned(
  store: OperationJournalOwner,
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
): void {
  store.writeOperationJournalOwned(state, steps, touched);
}

export function replaceOperationStateOwned(
  store: OperationJournalOwner,
  expectedIntegrityOid: string,
  state: OperationStateMetadata,
): void {
  store.replaceOperationStateOwned(expectedIntegrityOid, state);
}

export function replaceOperationJournalOwned(
  store: OperationJournalOwner,
  expectedIntegrityOid: string,
  state: OperationStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
): void {
  store.replaceOperationJournalOwned(expectedIntegrityOid, state, steps, touched);
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
  integrity_oid: unknown;
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
  integrityOid: string,
): OperationJournal {
  const fields = { steps, touched, integrityOid };
  if (state.kind === "merge") return { kind: state.kind, state, ...fields };
  if (state.kind === "cherry-pick") return { kind: state.kind, state, ...fields };
  if (state.kind === "revert") return { kind: state.kind, state, ...fields };
  return { kind: state.kind, state, ...fields };
}

export function sameOperationStep(
  left: OperationStepMetadata,
  right: OperationStepMetadata,
): boolean {
  return (
    left.sourceOid === right.sourceOid &&
    left.selectedParentOid === right.selectedParentOid &&
    left.mainline === right.mainline &&
    left.outcome === right.outcome &&
    left.resultOid === right.resultOid
  );
}

export function requireInitialRebaseJournal(
  state: RebaseStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
): void {
  if (
    state.phase !== "running" ||
    state.currentStep !== 0 ||
    touched.length !== 0 ||
    steps.some((step) => step.outcome !== "pending")
  ) {
    throw new CorruptError("initial rebase journal is not an untouched pending sequence");
  }
}

export function requireRebaseJournalTransition(
  current: RebaseJournal,
  state: RebaseStateMetadata,
  steps: readonly OperationStepMetadata[],
  touched: readonly MergeTouchedPath[],
): void {
  if (
    state.originalHeadRef !== current.state.originalHeadRef ||
    state.originalHeadOid !== current.state.originalHeadOid ||
    state.upstreamOid !== current.state.upstreamOid ||
    state.baseOid !== current.state.baseOid ||
    steps.length !== current.steps.length
  ) {
    throw new GitError("EOPMISMATCH", "rebase anchors or replay queue changed during transition");
  }
  for (let ordinal = 0; ordinal < steps.length; ordinal++) {
    const before = current.steps[ordinal];
    const after = steps[ordinal];
    if (
      before === undefined ||
      after === undefined ||
      before.sourceOid !== after.sourceOid ||
      before.selectedParentOid !== after.selectedParentOid ||
      before.mainline !== after.mainline
    ) {
      throw new GitError("EOPMISMATCH", "rebase replay queue changed during transition");
    }
  }
  if (
    state.currentStep === current.state.currentStep &&
    current.state.phase === "running" &&
    state.phase === "conflicted" &&
    touched.length > 0 &&
    steps.every((step, ordinal) => {
      const before = current.steps[ordinal];
      return before !== undefined && sameOperationStep(before, step);
    })
  ) {
    return;
  }
  if (
    state.currentStep === current.state.currentStep + 1 &&
    state.phase === "running" &&
    touched.length === 0
  ) {
    for (let ordinal = 0; ordinal < steps.length; ordinal++) {
      const before = current.steps[ordinal];
      const after = steps[ordinal];
      if (before === undefined || after === undefined) {
        throw new GitError("EOPMISMATCH", "rebase replay queue changed during transition");
      }
      if (ordinal === current.state.currentStep) {
        if (
          before.outcome !== "pending" ||
          (after.outcome !== "applied" && after.outcome !== "skipped")
        ) {
          throw new GitError("EOPMISMATCH", "rebase current step has an invalid transition");
        }
      } else if (!sameOperationStep(before, after)) {
        throw new GitError("EOPMISMATCH", "rebase completed or pending steps changed");
      }
    }
    return;
  }
  throw new GitError("EOPMISMATCH", "rebase journal transition is not contiguous");
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

export class OperationJournalTable {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly checkoutId: number,
    private readonly objects: ObjectTable,
  ) {}

  /** Read and validate the one durable incomplete integration operation. */
  readOperationState(): OperationJournal | null {
    return this.#readOperationStateOwned();
  }

  #readOperationStateOwned(): OperationJournal | null {
    const row = this.db.one<OperationStateRow>(
      `SELECT
              CASE WHEN typeof(kind) = 'text' AND length(CAST(kind AS BLOB)) <= 11
                   THEN kind END AS kind,
              CASE WHEN typeof(original_head_ref) = 'text'
                         AND length(CAST(original_head_ref AS BLOB)) <= ${MAX_MERGE_REF_BYTES}
                   THEN original_head_ref END AS original_head_ref,
              CASE WHEN typeof(original_head_oid) = 'text'
                         AND length(CAST(original_head_oid AS BLOB)) = 40
                   THEN original_head_oid END AS original_head_oid,
              CASE WHEN current_parent_oid IS NULL THEN NULL
                   WHEN typeof(current_parent_oid) = 'text'
                         AND length(CAST(current_parent_oid AS BLOB)) = 40
                   THEN current_parent_oid ELSE 0 END AS current_parent_oid,
              CASE WHEN incoming_parent_oid IS NULL THEN NULL
                   WHEN typeof(incoming_parent_oid) = 'text'
                         AND length(CAST(incoming_parent_oid AS BLOB)) = 40
                   THEN incoming_parent_oid ELSE 0 END AS incoming_parent_oid,
              CASE WHEN upstream_oid IS NULL THEN NULL
                   WHEN typeof(upstream_oid) = 'text'
                         AND length(CAST(upstream_oid AS BLOB)) = 40
                   THEN upstream_oid ELSE 0 END AS upstream_oid,
              CASE WHEN base_oid IS NULL THEN NULL
                   WHEN typeof(base_oid) = 'text' AND length(CAST(base_oid AS BLOB)) = 40
                   THEN base_oid ELSE 0 END AS base_oid,
              CASE WHEN typeof(phase) = 'text' AND length(CAST(phase AS BLOB)) <= 10
                   THEN phase END AS phase,
              CASE WHEN empty_reason IS NULL THEN NULL
                   WHEN typeof(empty_reason) = 'text'
                         AND length(CAST(empty_reason AS BLOB)) <= 6
                   THEN empty_reason ELSE 0 END AS empty_reason,
              CASE WHEN mode IS NULL THEN NULL
                   WHEN typeof(mode) = 'text' AND length(CAST(mode AS BLOB)) <= 9
                   THEN mode ELSE 0 END AS mode,
              CASE WHEN merge_origin IS NULL THEN NULL
                   WHEN typeof(merge_origin) = 'text' AND length(CAST(merge_origin AS BLOB)) <= 5
                   THEN merge_origin ELSE 0 END AS merge_origin,
              CASE WHEN typeof(current_step) = 'integer'
                         AND current_step >= 0 AND current_step <= ${MAX_OPERATION_STEPS}
                   THEN current_step END AS current_step,
              CASE WHEN typeof(step_count) = 'integer'
                         AND step_count >= 0 AND step_count <= ${MAX_OPERATION_STEPS}
                   THEN step_count END AS step_count,
              CASE WHEN typeof(current_label) = 'text'
                         AND length(CAST(current_label AS BLOB)) <= ${MAX_MERGE_LABEL_BYTES}
                   THEN current_label END AS current_label,
              CASE WHEN typeof(incoming_label) = 'text'
                         AND length(CAST(incoming_label AS BLOB)) <= ${MAX_MERGE_LABEL_BYTES}
                   THEN incoming_label END AS incoming_label,
              CASE WHEN typeof(message) = 'text'
                         AND length(CAST(message AS BLOB)) <= ${MAX_MERGE_MESSAGE_BYTES}
                   THEN message END AS message,
              CASE WHEN author_name IS NULL THEN NULL
                   WHEN typeof(author_name) = 'text'
                         AND length(CAST(author_name AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                   THEN author_name ELSE 0 END AS author_name,
              CASE WHEN author_email IS NULL THEN NULL
                   WHEN typeof(author_email) = 'text'
                         AND length(CAST(author_email AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                   THEN author_email ELSE 0 END AS author_email,
              CASE WHEN committer_name IS NULL THEN NULL
                   WHEN typeof(committer_name) = 'text'
                         AND length(CAST(committer_name AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                   THEN committer_name ELSE 0 END AS committer_name,
              CASE WHEN committer_email IS NULL THEN NULL
                   WHEN typeof(committer_email) = 'text'
                         AND length(CAST(committer_email AS BLOB)) <= ${MAX_MERGE_IDENTITY_BYTES}
                   THEN committer_email ELSE 0 END AS committer_email,
              touched_count,
              CASE WHEN typeof(integrity_oid) = 'text'
                         AND length(CAST(integrity_oid AS BLOB)) = 40
                   THEN integrity_oid END AS integrity_oid
         FROM git_operation_state WHERE checkout_id = ?`,
      this.checkoutId,
    );
    if (row === undefined) {
      const orphaned = requireBooleanProbe(
        this.db.scalar<unknown>(
          `SELECT EXISTS(
             SELECT 1 FROM git_operation_steps WHERE checkout_id = ?
             UNION ALL
             SELECT 1 FROM git_operation_touched WHERE checkout_id = ? LIMIT 1
           )`,
          this.checkoutId,
          this.checkoutId,
        ),
        "operation child-row orphan probe",
      );
      if (orphaned) throw new CorruptError("operation child rows exist without operation state");
      return null;
    }

    const stepCount = requireMergeInteger(row.step_count, "step count");
    if (stepCount > MAX_OPERATION_STEPS) {
      throw new GitError("E2BIG", `operation journal exceeds ${MAX_OPERATION_STEPS} steps`);
    }
    const touchedCount = requireMergeInteger(row.touched_count, "touched-path count");
    if (touchedCount > MAX_MERGE_TOUCHED_PATHS) {
      throw new GitError("E2BIG", `merge journal exceeds ${MAX_MERGE_TOUCHED_PATHS} touched paths`);
    }
    const steps: OperationStepMetadata[] = [];
    for (const raw of this.db.iterate(
      `SELECT CASE WHEN typeof(ordinal) = 'integer'
                            AND ordinal >= 0 AND ordinal < ${MAX_OPERATION_STEPS}
                   THEN ordinal END AS ordinal,
              CASE WHEN typeof(source_oid) = 'text'
                         AND length(CAST(source_oid AS BLOB)) = 40
                   THEN source_oid END AS source_oid,
              CASE WHEN selected_parent_oid IS NULL THEN NULL
                   WHEN typeof(selected_parent_oid) = 'text'
                         AND length(CAST(selected_parent_oid AS BLOB)) = 40
                   THEN selected_parent_oid ELSE 0 END AS selected_parent_oid,
              CASE WHEN mainline IS NULL THEN NULL
                   WHEN typeof(mainline) = 'integer' AND mainline >= 1
                        AND mainline <= ${Number.MAX_SAFE_INTEGER}
                   THEN mainline ELSE -1 END AS mainline,
              CASE WHEN typeof(outcome) = 'text' AND length(CAST(outcome AS BLOB)) <= 7
                   THEN outcome END AS outcome,
              CASE WHEN result_oid IS NULL THEN NULL
                   WHEN typeof(result_oid) = 'text' AND length(CAST(result_oid AS BLOB)) = 40
                   THEN result_oid ELSE 0 END AS result_oid
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
      const ordinal = requireMergeInteger(stepRow.ordinal, "step ordinal");
      if (ordinal !== steps.length) {
        throw new CorruptError("operation step ordinals are not contiguous");
      }
      if (steps.length >= stepCount || steps.length >= MAX_OPERATION_STEPS) {
        throw new CorruptError("operation journal yielded too many steps");
      }
      steps.push(operationStepFromRow(stepRow));
    }
    if (steps.length !== stepCount) {
      throw new CorruptError("operation step count does not match its rows");
    }
    const state = operationMetadataFromRow(row, steps);

    const touched: MergeTouchedPath[] = [];
    for (const raw of this.db.iterate(
      `SELECT ordinal,
              CASE WHEN typeof(path) = 'text'
                         AND length(CAST(path AS BLOB)) <= ${MAX_MERGE_PATH_BYTES}
                   THEN path END AS path,
              CASE WHEN typeof(logical_path) = 'text'
                         AND length(CAST(logical_path AS BLOB)) <= ${MAX_MERGE_PATH_BYTES}
                   THEN logical_path END AS logical_path,
              CASE WHEN typeof(purpose) = 'text' AND length(CAST(purpose AS BLOB)) <= 19
                   THEN purpose END AS purpose,
              index_stage, index_mode,
              CASE WHEN index_oid IS NULL THEN NULL
                   WHEN typeof(index_oid) = 'text' AND length(CAST(index_oid AS BLOB)) = 40
                   THEN index_oid ELSE 0 END AS index_oid,
              index_size, index_mtime, index_ino, index_rev,
              CASE WHEN typeof(worktree_kind) = 'text'
                         AND length(CAST(worktree_kind AS BLOB)) <= 9
                   THEN worktree_kind END AS worktree_kind,
              worktree_mode,
              CASE WHEN worktree_oid IS NULL THEN NULL
                   WHEN typeof(worktree_oid) = 'text'
                         AND length(CAST(worktree_oid AS BLOB)) = 40
                   THEN worktree_oid ELSE 0 END AS worktree_oid,
              worktree_revision
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
      const ordinal = requireMergeInteger(touchedRow.ordinal, "touched-path ordinal");
      if (ordinal !== touched.length) {
        throw new CorruptError("merge touched-path ordinals are not contiguous");
      }
      if (touched.length >= touchedCount || touched.length >= MAX_MERGE_TOUCHED_PATHS) {
        throw new CorruptError("merge journal yielded too many touched paths");
      }
      const entry = operationTouchedFromRow(touchedRow);
      touched.push(entry);
    }
    if (touched.length !== touchedCount) {
      throw new CorruptError("merge journal touched-path count does not match its rows");
    }
    const integrityOid = requireMergeOid(row.integrity_oid, "journal integrity oid");
    if (operationJournalIntegrityOid(state, touched, steps) !== integrityOid) {
      throw new CorruptError("operation journal integrity identity does not match its rows");
    }
    const journal = operationJournal(state, steps, touched, integrityOid);
    this.#validateOperationObjects(journal);
    return journal;
  }

  /** Atomically create one bounded operation journal; an existing operation wins. */
  writeOperationState(state: OperationStateMetadata, touched: readonly MergeTouchedPath[]): void {
    if (state.kind === "rebase") {
      throw new CorruptError("rebase creation requires an explicit replay sequence");
    }
    this.writeOperationJournal(state, operationStepsForState(state), touched);
  }

  /** Atomically create a complete authenticated operation header and child rows. */
  writeOperationJournal(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.#writeOperationJournalOwned(state, steps, touched);
  }

  #writeOperationJournalOwned(
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    if (state.kind === "rebase") requireInitialRebaseJournal(state, steps, touched);
    const integrityOid = operationJournalIntegrityOid(state, touched, steps);

    this.db.transactionSync(() => {
      const active = this.#readOperationStateOwned();
      if (active !== null) throw operationAlreadyActive(active.state.kind);
      const journal = operationJournal(state, steps, touched, integrityOid);
      this.#validateOperationObjects(journal);
      this.#insertOperationHeader(state, steps.length, touched.length, integrityOid);
      this.#insertOperationSteps(steps);
      this.#insertOperationTouched(touched);
      bumpMaintenanceRootEpoch(this.db, this.repoId);
    });
  }

  #insertOperationHeader(
    state: OperationStateMetadata,
    stepCount: number,
    touchedCount: number,
    integrityOid: string,
  ): void {
    this.db.run(
      `INSERT INTO git_operation_state
         (checkout_id, kind, original_head_ref, original_head_oid, phase, empty_reason,
          current_parent_oid, incoming_parent_oid, upstream_oid, base_oid, mode, merge_origin,
          current_step, step_count, current_label, incoming_label, message,
          author_name, author_email, committer_name, committer_email,
          touched_count, integrity_oid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      integrityOid,
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
         SELECT ?,
                json_extract(value, '$.ordinal'),
                json_extract(value, '$.sourceOid'),
                json_extract(value, '$.selectedParentOid'),
                json_extract(value, '$.mainline'),
                json_extract(value, '$.outcome'),
                json_extract(value, '$.resultOid')
           FROM json_each(?) ORDER BY CAST(json_extract(value, '$.ordinal') AS INTEGER)`,
        this.checkoutId,
        page,
      );
    }
  }

  #insertOperationTouched(touched: readonly MergeTouchedPath[]): void {
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
           (checkout_id, ordinal, path, logical_path, purpose,
            index_stage, index_mode, index_oid, index_size, index_mtime,
            index_ino, index_rev, worktree_kind, worktree_mode,
            worktree_oid, worktree_revision)
         SELECT ?,
                json_extract(value, '$.ordinal'),
                json_extract(value, '$.path'),
                json_extract(value, '$.logicalPath'),
                json_extract(value, '$.purpose'),
                json_extract(value, '$.indexStage'),
                json_extract(value, '$.indexMode'),
                json_extract(value, '$.indexOid'),
                json_extract(value, '$.indexSize'),
                json_extract(value, '$.indexMtime'),
                json_extract(value, '$.indexIno'),
                json_extract(value, '$.indexRev'),
                json_extract(value, '$.worktreeKind'),
                json_extract(value, '$.worktreeMode'),
                json_extract(value, '$.worktreeOid'),
                json_extract(value, '$.worktreeRevision')
           FROM json_each(?) ORDER BY CAST(json_extract(value, '$.ordinal') AS INTEGER)`,
        this.checkoutId,
        page,
      );
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
        add({
          oid: step.selectedParentOid,
          type: "commit",
          label: "step selected parent",
        });
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

    let page: string[] = [];
    const validatePage = (): void => {
      if (page.length === 0) return;
      let info: ObjectReadInfo[];
      try {
        info = this.objects.objectInfo(page);
      } catch (error) {
        if (hasErrorCode(error, "ENOTFOUND")) {
          throw new CorruptError("operation journal references a missing object", {
            cause: error,
          });
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
      page = [];
    };
    for (const oid of expected.keys()) {
      page.push(oid);
      if (page.length === MAX_BLOB_BATCH_OIDS) validatePage();
    }
    validatePage();
    if (journal.kind !== "merge") {
      this.#validateReplayTopology(journal, objectSizes);
    }
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
        (_oid, source) => {
          this.#validateReplayParentSelection(step, source.commit.parent);
        },
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
        if (step === undefined) throw new CorruptError("rebase source sequence is incomplete");
        const parents = source.commit.parent;
        if (
          parents.length !== 1 ||
          parents[0] !== expectedSourceParent ||
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

    const applied = journal.steps.filter((step) => step.outcome === "applied");
    let expectedResultParent = journal.state.upstreamOid;
    let resultOrdinal = 0;
    this.#validateOperationCommitBodies(
      applied.map((step) => {
        if (step.resultOid === null) throw new CorruptError("applied rebase step lost its result");
        return step.resultOid;
      }),
      (_oid, result) => {
        const step = applied[resultOrdinal++];
        if (step === undefined || step.resultOid === null) {
          throw new CorruptError("rebase result sequence is incomplete");
        }
        if (result.commit.parent.length !== 1 || result.commit.parent[0] !== expectedResultParent) {
          throw new CorruptError("applied rebase result has an invalid replay parent");
        }
        expectedResultParent = step.resultOid;
      },
      objectSizes,
    );
  }

  #validateOperationCommitBodies(
    oids: readonly string[],
    visit: (oid: string, commit: CommitCacheEntry) => void,
    objectSizes: ReadonlyMap<string, number>,
  ): void {
    const seen = new Set<string>();
    for (let offset = 0; offset < oids.length; offset += MAX_BLOB_BATCH_OIDS) {
      const page = oids.slice(offset, offset + MAX_BLOB_BATCH_OIDS);
      for (const oid of page) {
        if (seen.has(oid)) throw new CorruptError("operation commit sequence contains a cycle");
        seen.add(oid);
      }
      let remaining = page;
      while (remaining.length > 0) {
        for (const oid of remaining) {
          if (objectSizes.get(oid) === undefined) {
            throw new CorruptError(`operation commit ${oid} lost its validated size`);
          }
        }
        const batch = this.objects.readObjects(remaining, {
          budgetBytes: PACK_BLOB_BATCH_TARGET_BYTES,
        });
        remaining = [];
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

  /** Replace authenticated metadata while retaining the exact touched snapshot. */
  replaceOperationState(expectedIntegrityOid: string, state: OperationStateMetadata): void {
    this.#replaceOperationStateOwned(expectedIntegrityOid, state);
  }

  #replaceOperationStateOwned(expectedIntegrityOid: string, state: OperationStateMetadata): void {
    if (state.kind === "rebase") {
      throw new GitError("EOPMISMATCH", "rebase replacement requires a whole-journal transition");
    }
    if (!isOid(expectedIntegrityOid)) {
      throw new GitError("EINVAL", "expected operation integrity identity is invalid");
    }
    this.db.transactionSync(() => {
      const current = this.#readOperationStateOwned();
      if (current === null) throw operationNotActive(state.kind);
      if (current.state.kind !== state.kind) {
        throw operationKindMismatch(state.kind, current.state.kind);
      }
      if (current.integrityOid !== expectedIntegrityOid) {
        throw new GitError("EOPMISMATCH", "operation state changed before replacement");
      }
      const integrityOid = operationJournalIntegrityOid(state, current.touched, current.steps);
      this.#validateOperationObjects(
        operationJournal(state, current.steps, current.touched, integrityOid),
      );
      this.db.run(
        `UPDATE git_operation_state
            SET original_head_ref = ?, original_head_oid = ?, phase = ?, empty_reason = ?,
                current_parent_oid = ?, incoming_parent_oid = ?, upstream_oid = ?, base_oid = ?,
                mode = ?, merge_origin = ?, current_step = ?, current_label = ?, incoming_label = ?,
                message = ?, author_name = ?, author_email = ?, committer_name = ?,
                committer_email = ?, integrity_oid = ?
          WHERE checkout_id = ? AND integrity_oid = ?`,
        state.originalHeadRef,
        state.originalHeadOid,
        state.phase,
        state.kind === "cherry-pick" || state.kind === "revert" ? state.emptyReason : null,
        state.kind === "merge" ? state.currentParentOid : null,
        state.kind === "merge" ? state.incomingParentOid : null,
        null,
        null,
        state.kind === "merge" ? state.mode : null,
        state.kind === "merge" ? state.mergeOrigin : null,
        0,
        state.currentLabel,
        state.incomingLabel,
        state.message,
        state.author?.name ?? null,
        state.author?.email ?? null,
        state.committer?.name ?? null,
        state.committer?.email ?? null,
        integrityOid,
        this.checkoutId,
        expectedIntegrityOid,
      );
      bumpMaintenanceRootEpoch(this.db, this.repoId);
    });
  }

  /** Compare-and-swap one complete journal transition, including child rows. */
  replaceOperationJournal(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    this.#replaceOperationJournalOwned(expectedIntegrityOid, state, steps, touched);
  }

  #replaceOperationJournalOwned(
    expectedIntegrityOid: string,
    state: OperationStateMetadata,
    steps: readonly OperationStepMetadata[],
    touched: readonly MergeTouchedPath[],
  ): void {
    if (!isOid(expectedIntegrityOid)) {
      throw new GitError("EINVAL", "expected operation integrity identity is invalid");
    }
    const integrityOid = operationJournalIntegrityOid(state, touched, steps);
    this.db.transactionSync(() => {
      const current = this.#readOperationStateOwned();
      if (current === null) throw operationNotActive(state.kind);
      if (current.kind !== state.kind) throw operationKindMismatch(state.kind, current.kind);
      if (current.integrityOid !== expectedIntegrityOid) {
        throw new GitError("EOPMISMATCH", "operation state changed before replacement");
      }
      if (current.kind === "rebase") {
        if (state.kind !== "rebase") throw operationKindMismatch(state.kind, current.kind);
        requireRebaseJournalTransition(current, state, steps, touched);
      }
      const journal = operationJournal(state, steps, touched, integrityOid);
      this.#validateOperationObjects(journal);
      this.db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", this.checkoutId);
      this.db.run("DELETE FROM git_operation_steps WHERE checkout_id = ?", this.checkoutId);
      this.db.run(
        "DELETE FROM git_operation_state WHERE checkout_id = ? AND integrity_oid = ?",
        this.checkoutId,
        expectedIntegrityOid,
      );
      this.#insertOperationHeader(state, steps.length, touched.length, integrityOid);
      this.#insertOperationSteps(steps);
      this.#insertOperationTouched(touched);
      bumpMaintenanceRootEpoch(this.db, this.repoId);
    });
  }

  /** Clear operation metadata and touched snapshots, including corrupt orphans. */
  clearOperationState(): boolean {
    return this.db.transactionSync(() => {
      const existed = requireBooleanProbe(
        this.db.scalar<unknown>(
          `SELECT EXISTS(
             SELECT 1 FROM git_operation_state WHERE checkout_id = ?
             UNION ALL
             SELECT 1 FROM git_operation_steps WHERE checkout_id = ?
             UNION ALL
             SELECT 1 FROM git_operation_touched WHERE checkout_id = ? LIMIT 1
           )`,
          this.checkoutId,
          this.checkoutId,
          this.checkoutId,
        ),
        "operation state clear probe",
      );
      this.db.run("DELETE FROM git_operation_touched WHERE checkout_id = ?", this.checkoutId);
      this.db.run("DELETE FROM git_operation_steps WHERE checkout_id = ?", this.checkoutId);
      this.db.run("DELETE FROM git_operation_state WHERE checkout_id = ?", this.checkoutId);
      if (existed) bumpMaintenanceRootEpoch(this.db, this.repoId);
      return existed;
    });
  }

  /** Refuse an operation that cannot coexist with an incomplete operation. */
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
    if (journal.kind === "merge") return journal;
    if (journal.kind === "cherry-pick") return journal;
    if (journal.kind === "revert") return journal;
    return journal;
  }

  /** Merge-specific compatibility wrappers preserve the existing surface. */
  readMergeState(): MergeJournal | null {
    const journal = this.readOperationState();
    if (journal === null) return null;
    if (journal.kind !== "merge") {
      throw operationKindMismatch("merge", journal.kind);
    }
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
