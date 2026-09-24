import type { WriteEntry } from "@kompjutr/drive";
import { GitError } from "../../common/errors.js";
import { isNestedPath, joinPath } from "../../common/paths.js";
import { joinSorted, joinSorted3 } from "../../common/streams.js";
import { indexScanOwned } from "../../store/index.js";
import type { ProjectedMergeEntry } from "../../store/operations/integration-workspace/descriptors.js";
import { integrationPages } from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";
import type { OperationTouchedSource } from "../../store/operations/operation-journal-types.js";
import type { MergeTouchedPath } from "../../store/operations/operations.js";
import { requireSharedMutationScope } from "../core/mutation-scope.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { walkWorktreeEntriesStream } from "../worktree/worktree-io.js";
import { dirtyPathStream } from "../worktree/worktree-io-dirty.js";
import { collectBlobSizes, restoreWorktreeFiles } from "./apply/apply-blobs.js";
import { restoreIndex } from "./apply/apply-index.js";

interface GuardedTouchedPath {
  saved: MergeTouchedPath;
  indexed: boolean;
  dirty: boolean;
}

/** Each touched path with whether the index still holds it and whether its stage-0 entry is dirty. */
function* guardedTouched(
  repo: Repository,
  worktree: Worktree,
  touched: OperationTouchedSource,
): Generator<GuardedTouchedPath> {
  for (const row of joinSorted3(
    touched,
    indexScanOwned(repo.checkout),
    dirtyPathStream(repo, worktree),
    { a: (entry) => entry.path, b: (entry) => entry.path, c: (path) => path },
  )) {
    if (row.a === undefined) continue;
    yield { saved: row.a, indexed: row.b !== undefined, dirty: row.c !== undefined };
  }
}

/**
 * Mirrors Git's `reset --merge`: a present path whose stage-0 entry differs
 * from the worktree, or an untracked file the restore would overwrite, stops
 * the abort before anything is written. Unmerged paths are reset regardless.
 */
function requireRestorable(guarded: GuardedTouchedPath, currentIsDirectory: boolean): void {
  const { saved } = guarded;
  if (guarded.dirty) {
    throw new GitError("ECHECKOUTFAIL", `Entry '${saved.path}' not uptodate. Cannot merge.`);
  }
  if (
    !guarded.indexed &&
    !currentIsDirectory &&
    (saved.worktree.kind === "file" || saved.worktree.kind === "symlink")
  ) {
    throw new GitError(
      "ECHECKOUTFAIL",
      `Untracked working tree file '${saved.path}' would be overwritten by merge.`,
    );
  }
}

export function restoreIntegrationOwned(
  workspace: IntegrationWorkspace,
  repo: Repository,
  worktree: Worktree,
  touched: OperationTouchedSource,
): void {
  requireSharedMutationScope(repo.store.db, worktree);
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
      guardedTouched(repo, worktree, touched),
      walkWorktreeEntriesStream(worktree, repo.root, {
        includeDirectories: true,
        includeIgnored: true,
      }),
      {
        left: (entry) => entry.saved.path,
        right: (entry) => entry.path,
      },
    )) {
      if (row.left !== undefined && row.right !== undefined)
        requireRestorable(row.left, row.right.stat.type === "dir");
      const saved = row.left?.saved;
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
  function* files(): Generator<MergeTouchedPath> {
    for (const entry of touched)
      if (entry.worktree.kind === "file" || entry.worktree.kind === "symlink") yield entry;
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
