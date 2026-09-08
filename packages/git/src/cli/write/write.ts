import type { GitContext } from "../../ops/core/context.js";
import type { GitCliHandlers } from "../types.js";
import { createGitCliAddCommitHandlers } from "./write-add-commit.js";
import { createGitCliRefWriteHandlers } from "./write-refs.js";
import { createGitCliReplayWriteHandlers } from "./write-replay.js";

export { formatRebaseResult } from "./write-rebase-format.js";

type WriteHandlers = Pick<
  GitCliHandlers,
  "add" | "commit" | "branch" | "reset" | "checkout" | "switch" | "restore" | "rebase" | "merge"
>;

export function createGitCliWriteHandlers(context: GitContext): WriteHandlers {
  return {
    ...createGitCliAddCommitHandlers(context),
    ...createGitCliRefWriteHandlers(context),
    ...createGitCliReplayWriteHandlers(context),
  };
}
