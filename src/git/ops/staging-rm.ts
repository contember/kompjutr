import type { Repository } from "./repository.js";
import { runRm } from "./staging-rm-operation.js";
import type { RmOptions } from "./staging-rm-types.js";
import type { Worktree } from "./worktree.js";

export {
  ADD_RETAINED_BYTES,
  isExcluded,
  relativeExcludeRoots,
  structuralStringBytes,
} from "./staging-rm-support.js";
export type { RmOptions } from "./staging-rm-types.js";

/** Remove tracked paths with Git's HEAD/index/worktree safety checks. */
export function rm(repo: Repository, worktree: Worktree, options: RmOptions): void {
  runRm(repo, worktree, options);
}
