import type { GitClientServices } from "./client-services.js";
import type { Git } from "./client-types.js";
import { GitError } from "./common/errors.js";
import {
  configGet,
  configSet,
  remoteAdd,
  remoteGetUrl,
  remoteList,
  remoteRemove,
  remoteSetUrl,
} from "./ops/config.js";
import { hydrateTreeBlobs } from "./ops/network.js";
import {
  branchDelete as branchDeleteOp,
  branchList as branchListOp,
  branch as branchOp,
  branchRename as branchRenameOp,
  checkout as checkoutOp,
  tagDelete as tagDeleteOp,
  tagList as tagListOp,
  tag as tagOp,
} from "./ops/refs.js";

type RefMethods = Pick<
  Git,
  | "branch"
  | "branchDelete"
  | "branchRename"
  | "branchList"
  | "tag"
  | "tagDelete"
  | "tagList"
  | "checkout"
  | "remoteAdd"
  | "remoteGetUrl"
  | "remoteRemove"
  | "remoteSetUrl"
  | "remoteList"
  | "configGet"
  | "configSet"
>;

export function createGitClientRefMethods(services: GitClientServices): RefMethods {
  const { context, at, mutate } = services;
  return {
    async branch(input) {
      mutate(() => {
        const repo = at(input.dir);
        repo.checkout.requireNoOperationState();
        branchOp(context, repo, input);
      });
    },
    async branchDelete(input) {
      mutate(() => {
        const repo = at(input.dir);
        repo.checkout.requireNoOperationState();
        branchDeleteOp(context, repo, input);
      });
    },
    async branchRename(input) {
      mutate(() => branchRenameOp(context, at(input.dir), input));
    },
    async branchList(input = {}) {
      return branchListOp(at(input.dir));
    },
    async tag(input) {
      mutate(() => {
        const repo = at(input.dir);
        repo.checkout.requireNoOperationState();
        tagOp(context, repo, input);
      });
    },
    async tagDelete(input) {
      mutate(() => {
        const repo = at(input.dir);
        repo.checkout.requireNoOperationState();
        tagDeleteOp(context, repo, input);
      });
    },
    async tagList(input = {}) {
      return tagListOp(at(input.dir));
    },
    async checkout(input) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      const commit = repo.peel(repo.revParse(input.ref));
      const tree = repo.readCommit(commit).tree;
      await hydrateTreeBlobs(context, repo, tree, input.paths);
      mutate(() => {
        repo.checkout.requireNoOperationState();
        const currentCommit = repo.peel(repo.revParse(input.ref));
        if (currentCommit !== commit || repo.readCommit(currentCommit).tree !== tree) {
          throw new GitError(
            "ESTALE",
            `checkout target ${input.ref} changed during blob hydration`,
          );
        }
        checkoutOp(context, repo, context.worktree, input);
      });
    },
    async remoteAdd(input) {
      mutate(() => remoteAdd(at(input.dir), input));
    },
    async remoteGetUrl(input) {
      return remoteGetUrl(at(remoteOptionsDir(input, "remote get-url")), input);
    },
    async remoteRemove(input) {
      mutate(() => remoteRemove(at(input.dir), input));
    },
    async remoteSetUrl(input) {
      mutate(() => remoteSetUrl(at(remoteOptionsDir(input, "remote set-url")), input));
    },
    async remoteList(input = {}) {
      return remoteList(at(input.dir));
    },
    async configGet(input) {
      return configGet(at(input.dir), input);
    },
    async configSet(input) {
      mutate(() => configSet(at(input.dir), input));
    },
  };
}

function remoteOptionsDir(options: unknown, operation: string): string | undefined {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitError("EINVAL", `${operation} options must be an object`);
  }
  const dir = Reflect.get(options, "dir");
  if (dir !== undefined && typeof dir !== "string") {
    throw new GitError("EINVAL", `${operation} dir must be a string`);
  }
  return dir;
}
