import type { GitClientServices } from "./client-services.js";
import type { Git } from "./client-types.js";
import { UnsupportedOperationError } from "./common/errors.js";
import {
  cherryPickAbort as cherryPickAbortOp,
  cherryPickContinue as cherryPickContinueOp,
  cherryPick as cherryPickOp,
  cherryPickSkip as cherryPickSkipOp,
} from "./ops/cherry-pick.js";
import {
  mergeAbort as mergeAbortOp,
  mergeContinue as mergeContinueOp,
  merge as mergeOp,
} from "./ops/merge.js";
import {
  rebaseAbortExcluding as rebaseAbortOp,
  rebaseContinueExcluding as rebaseContinueOp,
  rebaseExcluding as rebaseOp,
  rebaseSkipExcluding as rebaseSkipOp,
} from "./ops/rebase.js";
import {
  revertAbort as revertAbortOp,
  revertContinue as revertContinueOp,
  revert as revertOp,
  revertSkip as revertSkipOp,
} from "./ops/revert.js";

type ReplayMethods = Pick<
  Git,
  | "merge"
  | "mergeContinue"
  | "mergeAbort"
  | "cherryPick"
  | "cherryPickContinue"
  | "cherryPickSkip"
  | "cherryPickAbort"
  | "revert"
  | "revertContinue"
  | "revertSkip"
  | "revertAbort"
  | "rebase"
  | "rebaseContinue"
  | "rebaseSkip"
  | "rebaseAbort"
  | "stashPush"
  | "stashList"
  | "stashPop"
>;

export function createGitClientReplayMethods(services: GitClientServices): ReplayMethods {
  const { context, at, excludeRoots, mutate } = services;
  return {
    async merge(input) {
      return mutate(() => {
        const repo = at(input.dir);
        return mergeOp(context, repo, context.worktree, input);
      });
    },
    async mergeContinue(input = {}) {
      return mutate(() => mergeContinueOp(context, at(input.dir), input));
    },
    async mergeAbort(input = {}) {
      mutate(() => mergeAbortOp(at(input.dir), context.worktree));
    },
    async cherryPick(input) {
      return mutate(() => cherryPickOp(context, at(input.dir), context.worktree, input));
    },
    async cherryPickContinue(input = {}) {
      return mutate(() => cherryPickContinueOp(context, at(input.dir), input));
    },
    async cherryPickSkip(input = {}) {
      mutate(() => cherryPickSkipOp(at(input.dir), context.worktree));
    },
    async cherryPickAbort(input = {}) {
      mutate(() => cherryPickAbortOp(at(input.dir), context.worktree));
    },
    async revert(input) {
      return mutate(() => revertOp(context, at(input.dir), context.worktree, input));
    },
    async revertContinue(input = {}) {
      return mutate(() => revertContinueOp(context, at(input.dir), input));
    },
    async revertSkip(input = {}) {
      mutate(() => revertSkipOp(at(input.dir), context.worktree));
    },
    async revertAbort(input = {}) {
      mutate(() => revertAbortOp(at(input.dir), context.worktree));
    },
    async rebase(input) {
      return mutate(() => {
        const repo = at(input.dir);
        return rebaseOp(context, repo, context.worktree, excludeRoots(repo), input);
      });
    },
    async rebaseContinue(input = {}) {
      return mutate(() => {
        const repo = at(input.dir);
        return rebaseContinueOp(context, repo, context.worktree, excludeRoots(repo), input);
      });
    },
    async rebaseSkip(input = {}) {
      return mutate(() => {
        const repo = at(input.dir);
        return rebaseSkipOp(context, repo, context.worktree, excludeRoots(repo), input);
      });
    },
    async rebaseAbort(input = {}) {
      mutate(() => {
        const repo = at(input.dir);
        rebaseAbortOp(repo, context.worktree, excludeRoots(repo));
      });
    },
    async stashPush() {
      throw new UnsupportedOperationError("stash push");
    },
    async stashList() {
      throw new UnsupportedOperationError("stash list");
    },
    async stashPop() {
      throw new UnsupportedOperationError("stash pop");
    },
  };
}
