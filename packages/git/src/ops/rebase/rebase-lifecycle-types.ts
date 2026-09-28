import type { GitIdentity } from "../core/context.js";
import type { RebaseResult } from "../core/kinds.js";

export interface RebaseStartOptions {
  upstream: string;
  committer?: GitIdentity;
  env?: Record<string, string>;
}

export interface RebaseContinueOptions {
  committer?: GitIdentity;
  env?: Record<string, string>;
}
export type RebaseLifecycleResult = RebaseResult;

export interface RebaseExclusions {
  absolute: string[];
  relative: string[];
}

/**
 * The replay parent whose tree the index and tracked worktree match. A whole-tree
 * check or a hard reset proves it; each step then keeps it true for its result.
 * It is valid only inside the synchronous call that proved it.
 */
export interface RebaseBaselineProof {
  readonly parentOid: string;
}
