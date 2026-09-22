import { GitError } from "../../common/errors.js";
import { dirnameOf } from "../../common/paths.js";
import { joinSorted } from "../../common/streams.js";
import { indexScanOwned } from "../../store/index.js";
import type {
  IntegrationEntry,
  IntegrationReservation,
} from "../../store/operations/integration-workspace/descriptors.js";
import type { IntegrationReservations } from "../../store/operations/integration-workspace/reservations.js";
import {
  type IntegrationPlanHandle,
  integrationPages,
} from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationTouched } from "../../store/operations/integration-workspace/touched.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";
import { projectMergePlanOwned } from "../merge/merge-projection.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import { walkWorktreeEntriesStreamOwned } from "../worktree/worktree-io.js";
import type { IntegrationOperation } from "./integration-worktree.js";

export function projectIntegrationWithCollisionsOwned(
  workspace: IntegrationWorkspace,
  repo: Repository,
  worktree: Worktree,
  baseTree: string | null,
  incomingTree: string | null,
  plan: IntegrationPlanHandle<IntegrationEntry>,
  currentLabel: string,
  incomingLabel: string,
  omitted: IntegrationTouched | undefined,
  operation: IntegrationOperation,
) {
  const options = { currentLabel, incomingLabel };
  const initial = projectMergePlanOwned(workspace, plan, options);
  let hasRelocations = false;
  for (const entry of initial.entries) {
    if (entry.purpose !== "primary") {
      hasRelocations = true;
      break;
    }
  }
  if (!hasRelocations) return initial;
  const tracked = workspace.reservations(initial, "tracked");
  const untracked = workspace.reservations(initial, "untracked");
  function* candidates(paths: Iterable<{ path: string }>) {
    for (const { path } of paths) {
      let candidate = path;
      while (candidate !== "") {
        yield { path: candidate, base: candidate };
        const underscore = candidate.lastIndexOf("_");
        if (underscore >= 0 && /^\d+$/.test(candidate.slice(underscore + 1)))
          yield { path: candidate, base: candidate.slice(0, underscore) };
        const parent = dirnameOf(candidate);
        candidate = parent === "/" ? "" : parent.slice(1);
      }
    }
  }
  function observe(paths: Iterable<{ path: string }>, collisions: IntegrationReservations): void {
    for (const page of integrationPages(candidates(paths))) {
      const entries = initial.entries.getMany(page.map((candidate) => candidate.base));
      function* matches(): Generator<IntegrationReservation> {
        for (const candidate of page) {
          const entry = entries.get(candidate.base);
          if (entry !== undefined && entry.purpose !== "primary")
            yield {
              path: candidate.path,
              logicalPath: candidate.path,
              purpose: "primary",
              identity: null,
            };
        }
      }
      collisions.add(matches());
    }
  }
  function* excluding(paths: Iterable<{ path: string }>) {
    let rows = 0;
    function* uniquePaths() {
      let previous: string | null = null;
      for (const entry of paths) {
        if (entry.path === previous) continue;
        previous = entry.path;
        yield entry;
      }
    }
    for (const row of joinSorted(uniquePaths(), omitted?.shapes() ?? [], {
      left: (entry) => entry.path,
      right: (entry) => entry.path,
    })) {
      if (rows++ >= 50_000)
        throw new GitError("E2BIG", `${operation} collision scan exceeds 50000 rows`);
      if (row.left !== undefined && row.right === undefined) yield row.left;
    }
  }
  observe(excluding(indexScanOwned(repo.checkout)), tracked);
  for (const tree of [baseTree, incomingTree]) {
    if (tree !== null) observe(workspace.source.walkTree(tree), tracked);
  }
  function* untrackedPaths() {
    let worktreeRows = 0;
    for (const row of joinSorted(
      indexScanOwned(repo.checkout),
      walkWorktreeEntriesStreamOwned(worktree, repo.root, { includeIgnored: true }),
      {
        left: (entry) => entry.path,
        right: (entry) => entry.path,
      },
    )) {
      if (worktreeRows++ >= 50_000)
        throw new GitError("E2BIG", `${operation} collision scan exceeds 50000 rows`);
      if (row.right !== undefined && row.left === undefined) yield row;
    }
  }
  observe(excluding(untrackedPaths()), untracked);
  return projectMergePlanOwned(workspace, plan, options, { tracked, untracked });
}
