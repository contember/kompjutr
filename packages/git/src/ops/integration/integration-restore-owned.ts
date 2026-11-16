import type { WriteEntry } from "@kompjutr/drive";
import { GitError } from "../../common/errors.js";
import { isNestedPath, joinPath } from "../../common/paths.js";
import { joinSorted } from "../../common/streams.js";
import { indexScanOwned } from "../../store/index.js";
import type { ProjectedMergeEntry } from "../../store/operations/integration-workspace/descriptors.js";
import { integrationPages } from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";
import type { OperationTouchedSource } from "../../store/operations/operation-journal-types.js";
import type { MergeTouchedPath } from "../../store/operations/operations.js";
import { checkoutTree } from "../checkout/checkout.js";
import { requireSharedMutationScope } from "../core/mutation-scope.js";
import { checkoutBlockers } from "../refs/refs.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { walkWorktreeEntriesStream } from "../worktree/worktree-io.js";
import { collectBlobSizes, restoreWorktreeFiles } from "./apply/apply-blobs.js";
import { restoreIndex } from "./apply/apply-index.js";

/**
 * Git's `reset --merge` to the pre-operation HEAD, which merge abort and
 * cherry-pick or revert skip and abort run. Every path is checked before
 * anything is written. Operation-owned paths return to their journaled state,
 * then every other index entry and its file follow HEAD's tree; an entry that
 * already matches keeps its worktree file. `touched` is null when nothing was applied.
 */
export function resetIntegrationOwned(
  workspace: IntegrationWorkspace,
  repo: Repository,
  worktree: Worktree,
  touched: OperationTouchedSource | null,
): void {
  requireSharedMutationScope(repo.store.db, worktree);
  const tree = repo.headTree();
  requireMergeResettable(repo, worktree, tree);
  if (touched !== null && touched.length > 0) restoreTouched(workspace, repo, worktree, touched);
  checkoutTree(repo, worktree, tree, {
    prune: true,
    preserveMatchingIndex: true,
    restoreStructure: true,
  });
}

/**
 * A changed index entry whose worktree file differs from it, or an untracked
 * file where HEAD's tree writes one, stops the reset as it stops Git's.
 */
function requireMergeResettable(repo: Repository, worktree: Worktree, tree: string | null): void {
  const blockers = checkoutBlockers(repo, worktree, {
    baselineTree: tree,
    tree,
    prune: true,
    mode: "merge",
  });
  const tracked = blockers.tracked[0];
  if (tracked !== undefined) {
    throw new GitError("ECHECKOUTFAIL", `Entry '${tracked}' not uptodate. Cannot merge.`);
  }
  const untracked = blockers.untracked[0];
  if (untracked !== undefined) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `Untracked working tree file '${untracked}' would be overwritten by merge.`,
    );
  }
}

interface RestoredTouchedPath {
  saved: MergeTouchedPath;
  /** The index holds the saved entry again, or no entry where none was saved. */
  unchanged: boolean;
}

function* restoredTouched(
  repo: Repository,
  touched: OperationTouchedSource,
): Generator<RestoredTouchedPath> {
  for (const row of joinSorted(touched, indexScanOwned(repo.checkout), {
    left: (entry) => entry.path,
    right: (entry) => entry.path,
  })) {
    if (row.left === undefined) continue;
    const saved = row.left.index;
    const current = row.right;
    yield {
      saved: row.left,
      unchanged:
        saved === null
          ? current === undefined
          : current?.stage === 0 && current.mode === saved.mode && current.oid === saved.oid,
    };
  }
}

function restoreTouched(
  workspace: IntegrationWorkspace,
  repo: Repository,
  worktree: Worktree,
  touched: OperationTouchedSource,
): void {
  const removals = workspace.projectedPlan();
  const absent = workspace.reservations(removals, "occupied");
  function* absentPaths() {
    for (const entry of touched)
      if (entry.worktree.kind === "absent")
        yield {
          path: entry.path,
          logicalPath: entry.logicalPath,
          purpose: entry.purpose,
          identity: null,
        };
  }
  absent.add(absentPaths());
  let removalCount = 0;
  function* removalEntries(): Generator<ProjectedMergeEntry> {
    let destructive: string | null = null;
    for (const row of joinSorted(
      restoredTouched(repo, touched),
      walkWorktreeEntriesStream(worktree, repo.root, {
        includeDirectories: true,
        includeIgnored: true,
      }),
      {
        left: (entry) => entry.saved.path,
        right: (entry) => entry.path,
      },
    )) {
      // An unchanged entry keeps its worktree entry, but a directory the
      // operation created never had one and still goes.
      const kept =
        row.left?.unchanged === true &&
        !(row.left.saved.worktree.kind === "absent" && row.right?.stat.type === "dir");
      const saved = kept ? undefined : row.left?.saved;
      if (destructive !== null && row.path !== destructive && !isNestedPath(destructive, row.path))
        destructive = null;
      if (destructive === null && saved !== undefined && saved.worktree.kind !== "directory")
        destructive = row.path;
      if (
        row.right !== undefined &&
        destructive !== null &&
        row.path !== destructive &&
        saved?.worktree.kind !== "absent" &&
        !absent.hasDescendant(row.path)
      ) {
        throw new GitError(
          "ECHECKOUTFAIL",
          `working tree path blocks merge restoration: ${row.path}`,
        );
      }
      if (saved === undefined) continue;
      const kind = saved.worktree.kind;
      const current = row.right?.stat.type;
      if (
        kind === "absent" ||
        (kind === "directory" ? current !== undefined && current !== "dir" : current === "dir")
      ) {
        removalCount++;
        yield {
          path: row.path,
          logicalPath: row.path,
          purpose: "primary",
          stageZero: null,
          stages: null,
          worktree: null,
          content: null,
        };
      }
    }
  }
  removals.entries.write(removalEntries());
  removals.finish(0, removalCount);
  for (const page of integrationPages(removals.entries))
    worktree.removeFiles(
      page.map((entry) => joinPath(repo.root, entry.path)),
      { recursive: true },
    );
  function* directories(): Generator<WriteEntry> {
    for (const entry of touched)
      if (entry.worktree.kind === "directory")
        yield { path: joinPath(repo.root, entry.path), mode: entry.worktree.mode & 0o7777 };
  }
  for (const page of integrationPages(directories())) worktree.writeFiles(page);
  // The index is still unrestored here, so this agrees with the removal pass.
  function* files(): Generator<MergeTouchedPath> {
    for (const { saved, unchanged } of restoredTouched(repo, touched))
      if (!unchanged && (saved.worktree.kind === "file" || saved.worktree.kind === "symlink"))
        yield saved;
  }
  for (const page of integrationPages(files())) {
    const sizes = collectBlobSizes(
      repo,
      page,
      (entry) =>
        entry.worktree.kind === "file" || entry.worktree.kind === "symlink"
          ? entry.worktree.oid
          : null,
      "merge abort",
    );
    restoreWorktreeFiles(repo, worktree, page, sizes);
  }
  restoreIndex(repo, touched);
}
