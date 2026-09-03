import type { MergeTouchedPath, OperationStepMetadata, RebaseStateMetadata } from "./operations.js";

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
