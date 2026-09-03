import { CorruptError } from "../../common/errors.js";
import { joinPath } from "../../common/paths.js";
import {
  suspendRebaseOwned,
  writeOperationJournalOwned,
} from "../../store/operations/operation-journal.js";
import { mergeOperationState, operationStepsForState } from "../core/operation-state.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { contentObjects, materialiseWrites, validateSourceBlobs } from "./merge-apply-blobs.js";
import { applyDestructiveRoots, applyIndex, structuralRemovals } from "./merge-apply-index.js";
import {
  indexSnapshots,
  snapshotWorktreeObjects,
  touchedFromDrafts,
  worktreeSnapshotScan,
} from "./merge-apply-snapshot.js";
import type {
  ActiveRebaseApply,
  MergeApplyMetadata,
  MergeApplyOutcome,
  MergeApplyResult,
  OperationApplyOptions,
  OperationApplyResult,
  ProjectedRebaseTransitionOptions,
  ProjectedRebaseTransitionResult,
  SnapshotDraft,
} from "./merge-apply-types.js";
import { touchedSpecs, validateProjectedIndexEntries } from "./merge-apply-validation.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import {
  type MergeStateMetadata,
  type MergeTouchedPath,
  validateMergeStateMetadata,
} from "./merge-state.js";

function outcomeOf(
  entries: readonly ProjectedMergeEntry[],
  mode: MergeApplyMetadata["mode"],
): MergeApplyOutcome {
  if (entries.some((entry) => entry.stages !== null)) return "conflicted";
  return mode === "no-commit" ? "ready" : "clean";
}

function metadataForOutcome(
  metadata: MergeApplyMetadata,
  outcome: Exclude<MergeApplyOutcome, "clean">,
): MergeStateMetadata {
  return { ...metadata, phase: outcome };
}
/** Apply inside the caller's transaction so journal and mutations commit together. */
function applyProjectedOperationInternal(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: OperationApplyOptions,
  activeRebase: ActiveRebaseApply | null,
): OperationApplyResult {
  validateProjectedIndexEntries(entries);
  if (activeRebase === null) repo.checkout.requireNoOperationState();
  else if (options.suspendedState !== null) {
    throw new CorruptError("rebase apply supplied two journal transitions");
  }
  const suspendedState = activeRebase?.conflictState ?? options.suspendedState;

  const retainedSpecs = touchedSpecs(entries);
  const specs = retainedSpecs.entries;
  const owned = specs.map((spec) => spec.path);
  const destructive = applyDestructiveRoots(entries);
  const worktreeRows = worktreeSnapshotScan(repo, worktree, specs, destructive.entries, owned);
  let drafts: SnapshotDraft[] = [];
  if (suspendedState !== null) {
    const snapshots = indexSnapshots(repo, specs);
    drafts = specs.map((spec) => ({
      spec,
      index: snapshots.entries.get(spec.path) ?? null,
      stat: worktreeRows.entries.get(spec.path) ?? null,
    }));
  }

  const sourceBlobs = validateSourceBlobs(repo, entries);
  const removals = structuralRemovals(entries, worktreeRows.entries);

  let touched: readonly MergeTouchedPath[] | null = null;
  if (suspendedState !== null) {
    const snapshots = snapshotWorktreeObjects(repo, worktree, drafts);
    touched = touchedFromDrafts(drafts, snapshots.entries);
  }

  const content = contentObjects(repo, entries);
  if (removals.entries.length > 0) {
    const absolute = removals.entries.map((path) => joinPath(repo.root, path));
    worktree.removeFiles(absolute, { recursive: true });
  }
  materialiseWrites(repo, worktree, entries, content.entries, sourceBlobs);
  applyIndex(repo.checkout, entries, specs);
  if (touched !== null) {
    if (suspendedState === null) throw new CorruptError("operation snapshot lost its state");
    if (activeRebase === null) {
      if (suspendedState.kind === "rebase") {
        throw new CorruptError("rebase apply omitted its active journal");
      }
      writeOperationJournalOwned(
        repo.checkout,
        suspendedState,
        operationStepsForState(suspendedState),
        touched,
      );
    } else {
      suspendRebaseOwned(repo.checkout, activeRebase.currentStep, touched);
    }
  }
  return { touched };
}

/** Apply a normal operation inside its caller-owned transaction. */
export function applyProjectedOperation(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: OperationApplyOptions,
): OperationApplyResult {
  return applyProjectedOperationInternal(repo, worktree, entries, options, null);
}

/** Own the transaction that couples active-rebase mutation to its journal transition. */
export function applyProjectedRebaseTransition<T>(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  options: ProjectedRebaseTransitionOptions<T>,
): ProjectedRebaseTransitionResult<T> {
  return repo.store.db.transactionSync(() => {
    const applied = applyProjectedOperationInternal(
      repo,
      worktree,
      entries,
      { suspendedState: null },
      options,
    );
    if (options.conflictState !== null) {
      if (applied.touched === null) {
        throw new CorruptError("conflicted rebase apply omitted its ownership snapshot");
      }
      return { outcome: "conflicted" };
    }
    if (applied.touched !== null) {
      throw new CorruptError("clean rebase apply unexpectedly retained ownership snapshots");
    }
    return { outcome: "clean", value: options.onClean(applied) };
  });
}

export function applyProjectedMerge(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  metadata: MergeApplyMetadata,
): MergeApplyResult {
  {
    const outcome = outcomeOf(entries, metadata.mode);
    if (outcome === "clean") {
      validateMergeStateMetadata({ ...metadata, phase: "conflicted" });
    }
    const state = outcome === "clean" ? null : metadataForOutcome(metadata, outcome);
    const applied = applyProjectedOperationInternal(
      repo,
      worktree,
      entries,
      { suspendedState: state === null ? null : mergeOperationState(state) },
      null,
    );
    const journal =
      state === null || applied.touched === null
        ? null
        : {
            state,
            touched: applied.touched,
          };
    return { outcome, journal };
  }
}
