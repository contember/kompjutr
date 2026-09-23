import type { WriteEntry } from "@kompjutr/drive";
import { GitError } from "../../common/errors.js";
import { isNestedPath, joinPath } from "../../common/paths.js";
import { joinSorted } from "../../common/streams.js";
import type { ProjectedMergeEntry } from "../../store/operations/integration-workspace/descriptors.js";
import { integrationPages } from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";
import type { OperationTouchedSource } from "../../store/operations/operation-journal-types.js";
import type { MergeTouchedPath } from "../../store/operations/operations.js";
import { requireSharedMutationScope } from "../core/mutation-scope.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { walkWorktreeEntriesStream } from "../worktree/worktree-io.js";
import { collectBlobSizes, restoreWorktreeFiles } from "./apply/apply-blobs.js";
import { restoreIndex } from "./apply/apply-index.js";

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
      touched,
      walkWorktreeEntriesStream(worktree, repo.root, {
        includeDirectories: true,
        includeIgnored: true,
      }),
      {
        left: (entry) => entry.path,
        right: (entry) => entry.path,
      },
    )) {
      if (destructive !== null && row.path !== destructive && !isNestedPath(destructive, row.path))
        destructive = null;
      if (destructive === null && row.left !== undefined && row.left.worktree.kind !== "directory")
        destructive = row.path;
      if (
        row.right !== undefined &&
        destructive !== null &&
        row.path !== destructive &&
        row.left?.worktree.kind !== "absent" &&
        !absent.hasDescendant(row.path)
      ) {
        throw new GitError(
          "ECHECKOUTFAIL",
          `working tree path blocks merge restoration: ${row.path}`,
        );
      }
      const saved = row.left;
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
