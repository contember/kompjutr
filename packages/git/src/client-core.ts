import type { GitClientServices } from "./client-services.js";
import type { Git, GitLsFilesOptions } from "./client-types.js";
import { GitError } from "./common/errors.js";
import { recoverRefOwned as recoverRefOp, reflog as reflogOp } from "./ops/core/ref-log.js";
import { diff as diffOp, diffSummary as diffSummaryOp } from "./ops/diff/diff.js";
import { mergeContinue as mergeContinueOp } from "./ops/merge/merge.js";
import { divergence as divergenceOp, mergeBase as mergeBaseOp } from "./ops/merge/merge-base.js";
import { lsRemote as lsRemoteOp } from "./ops/network/ls-remote.js";
import {
  clone as cloneOp,
  fetchInto,
  validateFetchOptions,
  withPromisorHydration,
} from "./ops/network/network.js";
import { currentBranch as currentBranchOp } from "./ops/refs/refs.js";
import { commit as commitOp } from "./ops/repository/commit.js";
import { initRepository } from "./ops/repository/init.js";
import { maintenance as maintenanceOp } from "./ops/repository/maintenance.js";
import { readRef as readRefOp, repoRoot as repoRootOp } from "./ops/repository/plumbing.js";
import {
  log as logOp,
  lsFilesAtRef,
  lsTree as lsTreeOp,
  show as showOp,
} from "./ops/repository/reads.js";
import {
  add as addOp,
  lsFilesWithWorktree,
  reset as resetOp,
  rm as rmOp,
} from "./ops/staging/staging.js";
import {
  clean as cleanOp,
  eagerStatus,
  type StatusDetail,
  statusBranch,
} from "./ops/status/status.js";
import {
  worktreeAddOwned as worktreeAddOp,
  worktreeList as worktreeListOp,
  worktreePruneOwned as worktreePruneOp,
  worktreeRemoveOwned as worktreeRemoveOp,
} from "./ops/worktree/worktrees.js";
import { checkoutStoreMutations } from "./store/core/checkout-mutations-registry.js";

type CoreMethods = Pick<
  Git,
  | "clone"
  | "fetch"
  | "lsRemote"
  | "init"
  | "status"
  | "statusReport"
  | "diff"
  | "diffSummary"
  | "clean"
  | "add"
  | "rm"
  | "reset"
  | "commit"
  | "log"
  | "show"
  | "revParse"
  | "tryRevParse"
  | "divergence"
  | "mergeBase"
  | "readRef"
  | "worktreeAdd"
  | "worktreeList"
  | "worktreeRemove"
  | "worktreePrune"
  | "reflog"
  | "recoverRef"
  | "repoRoot"
  | "maintenance"
  | "currentBranch"
  | "lsFiles"
  | "lsTree"
>;

export function createGitClientCoreMethods(services: GitClientServices): CoreMethods {
  const { context, at, excludeRoots, mutate } = services;
  return {
    async clone(input) {
      await cloneOp(context, input);
    },
    async fetch(input = {}) {
      validateFetchOptions(input);
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      return fetchInto(context, repo, input);
    },
    async lsRemote(input = {}) {
      return lsRemoteOp(context, at(input.dir), input);
    },
    async init(input = {}) {
      mutate(() => initRepository(context, input));
    },
    async status(input = {}) {
      const { dir, ...statusOptions } = input;
      const repo = at(dir);
      return eagerStatus(
        repo,
        context.worktree,
        { ...statusOptions, excludeRoots: excludeRoots(repo) },
        context,
      ).map(publicStatusEntry);
    },
    async statusReport(input = {}) {
      const { branch, dir, ...statusOptions } = input;
      const repo = at(dir);
      const entries = eagerStatus(
        repo,
        context.worktree,
        { ...statusOptions, excludeRoots: excludeRoots(repo) },
        context,
      ).map(publicStatusEntry);
      return branch === true ? { entries, branch: statusBranch(repo) } : { entries };
    },
    async diff(input = {}) {
      const repo = at(input.dir);
      return withPromisorHydration(context, repo, () =>
        diffOp(repo, context.worktree, input, context.sparseWorkspace),
      );
    },
    async diffSummary(input = {}) {
      const repo = at(input.dir);
      return withPromisorHydration(context, repo, () =>
        diffSummaryOp(repo, context.worktree, input, context.sparseWorkspace),
      );
    },
    async clean(input = {}) {
      return mutate(() => {
        const repo = at(input.dir);
        repo.checkout.requireNoOperationState();
        return cleanOp(repo, context.worktree, { ...input, excludeRoots: excludeRoots(repo) });
      });
    },
    async add(input) {
      mutate(() => {
        const repo = at(input.dir);
        addOp(repo, context.worktree, { ...input, excludeRoots: excludeRoots(repo) }, context);
      });
    },
    async rm(input) {
      mutate(() => {
        const repo = at(input.dir);
        rmOp(repo, context.worktree, { ...input, excludeRoots: excludeRoots(repo) });
      });
    },
    async reset(input = {}) {
      mutate(() => {
        const repo = at(input.dir);
        if (input.hard === true) {
          repo.store.db.transactionSync(() => {
            resetOp(context, repo, context.worktree, input);
            checkoutStoreMutations(repo.checkout).clearOperationStateOwned();
          });
          return;
        }
        repo.checkout.requireNoOperationState();
        resetOp(context, repo, context.worktree, input);
      });
    },
    async commit(input) {
      return mutate(() => {
        const repo = at(input.dir);
        const operation = repo.checkout.readOperationState();
        if (operation?.kind === "merge") {
          if (input.amend === true) {
            throw new GitError("EINVAL", "cannot amend while continuing a merge");
          }
          const result = mergeContinueOp(context, repo, input);
          if (result.oid === undefined) {
            throw new GitError("ECORRUPT", "merge continuation did not create a commit");
          }
          return { oid: result.oid };
        }
        if (operation !== null) repo.checkout.requireNoOperationState();
        return commitOp(context, repo, input);
      });
    },
    async log(input = {}) {
      return logOp(at(input.dir), input);
    },
    async show(input) {
      const repo = at(input.dir);
      return withPromisorHydration(context, repo, () => showOp(repo, input));
    },
    async revParse(input) {
      return at(input.dir).revParse(input.ref);
    },
    async tryRevParse(input) {
      return at(input.dir).tryRevParse(input.ref);
    },
    async divergence(input) {
      return divergenceOp(at(input.dir), input);
    },
    async mergeBase(input) {
      return mergeBaseOp(at(input.dir), input);
    },
    async readRef(input) {
      return readRefOp(at(input.dir), input);
    },
    async worktreeAdd(input) {
      return mutate(() => worktreeAddOp(context, at(input.dir), input));
    },
    async worktreeList(input = {}) {
      return worktreeListOp(context, at(input.dir));
    },
    async worktreeRemove(input) {
      mutate(() => worktreeRemoveOp(context, at(input.dir), input));
    },
    async worktreePrune(input = {}) {
      return mutate(() => worktreePruneOp(context, at(input.dir)));
    },
    async reflog(input = {}) {
      return reflogOp(at(input.dir), input);
    },
    async recoverRef(input) {
      mutate(() => {
        const repo = at(input.dir);
        repo.checkout.requireNoOperationState();
        recoverRefOp(context, repo, input);
      });
    },
    async repoRoot(input = {}) {
      return repoRootOp(context, input);
    },
    async maintenance(input = {}) {
      return maintenanceOp(context, at(input.dir));
    },
    async currentBranch(input = {}) {
      return currentBranchOp(at(input.dir), input);
    },
    async lsFiles(input = {}) {
      const { dir, ref, ...lsFilesOptions } = input;
      const repo = at(dir);
      if (ref !== undefined) {
        rejectRefWorktreeSelection(input);
        return lsFilesAtRef(repo, ref, lsFilesOptions);
      }
      return lsFilesWithWorktree(repo, context.worktree, {
        ...lsFilesOptions,
        excludeRoots: excludeRoots(repo),
      });
    },
    async lsTree(input) {
      return lsTreeOp(at(input.dir), input.ref, input.path, { recursive: input.recursive });
    },
  };
}

function rejectRefWorktreeSelection(input: GitLsFilesOptions): void {
  for (const key of ["cached", "others", "excludeStandard"]) {
    if (Reflect.has(input, key)) {
      throw new GitError("EINVAL", `ls-files ${key} is unavailable with ref`);
    }
  }
}

function publicStatusEntry(row: StatusDetail): import("./ops/core/kinds.js").StatusEntry {
  if (row.renamed === true) {
    return {
      path: row.path,
      index: row.index,
      worktree: row.worktree,
      originalPath: row.originalPath,
      similarity: row.similarity,
    };
  }
  return { path: row.path, index: row.index, worktree: row.worktree };
}
