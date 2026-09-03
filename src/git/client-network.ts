import type { GitClientServices } from "./client-services.js";
import type { Git } from "./client-types.js";
import { pull as pullOp } from "./ops/pull.js";
import { push as pushOp } from "./ops/push.js";

type NetworkMethods = Pick<Git, "push" | "pull">;

export function createGitClientNetworkMethods(services: GitClientServices): NetworkMethods {
  const { context, at } = services;
  return {
    async push(input = {}) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      return pushOp(context, repo, input);
    },
    async pull(input = {}) {
      const repo = at(input.dir);
      repo.checkout.requireNoOperationState();
      return pullOp(context, repo, context.worktree, input);
    },
  };
}
