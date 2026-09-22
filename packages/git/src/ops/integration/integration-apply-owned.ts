import type { WriteEntry } from "@kompjutr/drive";
import { fromHex, utf8Decoder } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { MODE_COMMIT, MODE_SYMLINK } from "../../common/objects.js";
import { isNestedPath, joinPath } from "../../common/paths.js";
import { comparePaths, joinSorted, joinSorted3, peekable } from "../../common/streams.js";
import { indexScanOwned, PACK_BLOB_BATCH_TARGET_BYTES } from "../../store/index.js";
import type { ProjectedMergeEntry } from "../../store/operations/integration-workspace/descriptors.js";
import {
  type IntegrationPlanHandle,
  integrationPages,
} from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationTouched } from "../../store/operations/integration-workspace/touched.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";
import {
  suspendRebaseOwned,
  writeOperationJournalOwned,
} from "../../store/operations/operation-journal.js";
import { requireSharedMutationScope } from "../core/mutation-scope.js";
import { operationStepsForState } from "../core/operation-state.js";
import { applyIndex } from "../merge/merge-apply-index.js";
import { snapshotWorktreeObjects, touchedFromDrafts } from "../merge/merge-apply-snapshot.js";
import type {
  ActiveRebaseApply,
  OperationApplyOptions,
  SnapshotDraft,
} from "../merge/merge-apply-types.js";
import { validateProjectedIndexEntries } from "../merge/merge-apply-validation.js";
import type { Repository } from "../repository/repository.js";
import { fileModeFor, type Worktree } from "../worktree/worktree.js";
import { walkWorktreeEntriesStreamOwned } from "../worktree/worktree-io.js";
import { integrationTouched } from "./integration-touched.js";

function* snapshotDrafts(
  repo: Repository,
  worktree: Worktree,
  plan: IntegrationPlanHandle<ProjectedMergeEntry>,
  touched: IntegrationTouched,
): Generator<SnapshotDraft> {
  const projected = plan.entries[Symbol.iterator]();
  let next = projected.next();
  let destructive: string | null = null;
  try {
    for (const row of joinSorted3(
      touched.shapes(),
      indexScanOwned(repo.checkout),
      walkWorktreeEntriesStreamOwned(worktree, repo.root, {
        includeIgnored: true,
        includeDirectories: true,
      }),
      { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
    )) {
      if (destructive !== null && row.path !== destructive && !isNestedPath(destructive, row.path))
        destructive = null;
      while (!next.done && comparePaths(next.value.path, row.path) < 0) next = projected.next();
      if (
        !next.done &&
        next.value.path === row.path &&
        destructive === null &&
        next.value.worktree?.mode !== MODE_COMMIT
      )
        destructive = row.path;
      if (
        row.c !== undefined &&
        destructive !== null &&
        row.path !== destructive &&
        row.a === undefined
      ) {
        throw new GitError(
          "ECHECKOUTFAIL",
          `working tree path blocks merge restoration: ${row.path}`,
        );
      }
      if (row.a === undefined) continue;
      if (row.b !== undefined && row.b.stage !== 0)
        throw new GitError("EUNMERGED", "cannot apply a merge over unmerged index entries");
      const entry = row.b;
      yield {
        spec: row.a,
        index:
          entry === undefined
            ? null
            : {
                stage: 0,
                mode: entry.mode,
                oid: entry.oid,
                size: entry.size,
                mtime: entry.mtime,
                ino: entry.ino,
                rev: entry.rev ?? null,
              },
        stat: row.c?.stat ?? null,
      };
    }
  } finally {
    projected.return(undefined);
  }
}

function* outputEntries(
  plan: IntegrationPlanHandle<ProjectedMergeEntry>,
): Generator<ProjectedMergeEntry> {
  for (const entry of plan.entries) if (entry.worktree !== null) yield entry;
}

function materialize(
  workspace: IntegrationWorkspace,
  repo: Repository,
  worktree: Worktree,
  plan: IntegrationPlanHandle<ProjectedMergeEntry>,
): void {
  for (const page of integrationPages(outputEntries(plan))) {
    const oidOf = (entry: ProjectedMergeEntry) => entry.content?.oid ?? entry.worktree?.oid ?? "";
    const info = workspace.source.objectInfo([...new Set(page.map(oidOf))]);
    const sizes = new Map(info.map((object) => [object.oid, object.size]));
    for (const object of info)
      if (object.type !== "blob")
        throw new CorruptError(`merge output object ${object.oid} is not a blob`);
    let start = 0;
    while (start < page.length) {
      let end = start;
      let bytes = 0;
      while (end < page.length) {
        const size = sizes.get(oidOf(page[end]!));
        if (size === undefined) throw new CorruptError("merge output metadata is missing");
        if (end > start && bytes + size > PACK_BLOB_BATCH_TARGET_BYTES) break;
        bytes += size;
        end++;
      }
      const selected = page.slice(start, end);
      const batch = workspace.source.readBlobs([...new Set(selected.map(oidOf))], {
        budgetBytes: Math.max(1, bytes),
      });
      const writes: WriteEntry[] = [];
      for (const entry of selected) {
        if (entry.worktree === null)
          throw new CorruptError("merge output lost its worktree identity");
        const oid = oidOf(entry);
        const data = batch.blobs.get(oid);
        if (data === undefined) break;
        const path = joinPath(repo.root, entry.path);
        const contentId = fromHex(oid);
        writes.push(
          entry.worktree.mode === MODE_SYMLINK
            ? { path, target: utf8Decoder.decode(data), contentId }
            : { path, bytes: data, mode: fileModeFor(entry.worktree.mode), contentId },
        );
      }
      if (writes.length === 0) throw new CorruptError("merge output read made no progress");
      worktree.writeFiles(writes);
      start += writes.length;
    }
  }
}

export function adoptProjectedIndex(
  workspace: IntegrationWorkspace,
  plan: IntegrationPlanHandle<ProjectedMergeEntry>,
): void {
  function* oids(): Generator<string> {
    for (const entry of plan.entries) {
      for (const identity of [
        entry.stageZero,
        entry.stages?.base,
        entry.stages?.current,
        entry.stages?.incoming,
      ]) {
        if (identity !== null && identity !== undefined) yield identity.oid;
      }
    }
  }
  workspace.source.adoptMany(oids());
}

export function applyIntegrationOwned(
  workspace: IntegrationWorkspace,
  repo: Repository,
  worktree: Worktree,
  plan: IntegrationPlanHandle<ProjectedMergeEntry>,
  options: OperationApplyOptions,
  activeRebase: ActiveRebaseApply | null = null,
): { touched: IntegrationTouched | null } {
  requireSharedMutationScope(repo.store.db, worktree);
  validateProjectedIndexEntries(plan.entries);
  if (activeRebase === null) repo.checkout.requireNoOperationState();
  else if (options.suspendedState !== null)
    throw new CorruptError("rebase apply supplied two journal transitions");
  const state = activeRebase?.conflictState ?? options.suspendedState;
  const touched = integrationTouched(workspace, plan);
  for (const page of integrationPages(snapshotDrafts(repo, worktree, plan, touched))) {
    const objects = state === null ? null : snapshotWorktreeObjects(repo, worktree, page).entries;
    touched.save(touchedFromDrafts(page, objects));
  }
  const removals = workspace.projectedPlan();
  let removalCount = 0;
  function* removalEntries(): Generator<ProjectedMergeEntry> {
    const writes = peekable(outputEntries(plan));
    try {
      for (const row of joinSorted(touched, plan.entries, {
        left: (entry) => entry.path,
        right: (entry) => entry.path,
      })) {
        const before = row.left;
        if (before === undefined) continue;
        const entry = row.right;
        const removeExact =
          entry !== undefined && (entry.worktree === null || before.worktree.kind === "directory");
        let removeAncestor = false;
        if (before.worktree.kind === "file" || before.worktree.kind === "symlink") {
          while (
            writes.peek() !== undefined &&
            comparePaths(writes.peek()!.path, `${before.path}/`) < 0
          )
            writes.next();
          removeAncestor = writes.peek()?.path.startsWith(`${before.path}/`) === true;
        }
        if (removeExact || removeAncestor) {
          removalCount++;
          yield {
            path: before.path,
            logicalPath: before.logicalPath,
            purpose: before.purpose,
            stageZero: null,
            stages: null,
            worktree: null,
            content: null,
          };
        }
      }
    } finally {
      writes.close();
    }
  }
  removals.entries.write(removalEntries());
  removals.finish(0, removalCount);
  adoptProjectedIndex(workspace, plan);
  for (const page of integrationPages(removals.entries))
    worktree.removeFiles(
      page.map((entry) => joinPath(repo.root, entry.path)),
      { recursive: true },
    );
  materialize(workspace, repo, worktree, plan);
  applyIndex(repo.checkout, plan.entries, touched.shapes());
  if (state !== null) {
    if (activeRebase !== null) suspendRebaseOwned(repo.checkout, activeRebase.currentStep, touched);
    else {
      if (state.kind === "rebase")
        throw new CorruptError("rebase apply omitted its active journal");
      writeOperationJournalOwned(repo.checkout, state, operationStepsForState(state), touched);
    }
  }
  return { touched: state === null ? null : touched };
}
