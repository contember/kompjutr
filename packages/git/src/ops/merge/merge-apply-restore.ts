import { checkoutStoreMutations } from "../../store/core/checkout-mutations-registry.js";
import { withIntegrationWorkspaceOwned } from "../../store/operations/integration-workspace/workspace.js";
import type { OperationJournal } from "../core/operation-state.js";
import { restoreIntegrationOwned } from "../integration/integration-restore-owned.js";
import type { Repository } from "../repository/repository.js";
import type { Worktree } from "../worktree/worktree.js";
import type { MergeJournal } from "./merge-state.js";

export function abortProjectedMerge(
  repo: Repository,
  worktree: Worktree,
  journal: MergeJournal,
): void {
  withIntegrationWorkspaceOwned(repo.store, (workspace) => {
    restoreIntegrationOwned(workspace, repo, worktree, journal.touched, [
      journal.state.originalHeadOid,
      journal.state.currentParentOid,
      journal.state.incomingParentOid,
    ]);
    checkoutStoreMutations(repo.checkout).clearMergeStateOwned();
  });
}

export function restoreProjectedOperation(
  repo: Repository,
  worktree: Worktree,
  journal: OperationJournal,
): void {
  withIntegrationWorkspaceOwned(repo.store, (workspace) =>
    restoreIntegrationOwned(workspace, repo, worktree, journal.touched),
  );
}
