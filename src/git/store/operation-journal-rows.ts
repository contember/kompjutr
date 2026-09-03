import { CorruptError } from "../common/errors.js";
import type {
  OperationStateRow,
  OperationStepRow,
  OperationTouchedRow,
  PersistedOperationStep,
  PersistedOperationTouched,
} from "./operation-journal-types.js";
import {
  type MergeIndexSnapshot,
  type MergeSavedIdentity,
  type MergeTouchedPath,
  type MergeWorktreeSnapshot,
  type OperationJournal,
  type OperationKind,
  type OperationStateMetadata,
  type OperationStepMetadata,
  requireMergeInteger,
  requireMergeMode,
  requireMergeNullableInteger,
  requireMergeOid,
  requireMergeOrigin,
  requireMergePhase,
  requireMergePurpose,
  requireMergeText,
} from "./operations.js";

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
