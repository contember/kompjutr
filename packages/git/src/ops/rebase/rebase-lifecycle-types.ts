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
 * The replay parent whose tree the index and tracked worktree match. It is proved
 * by a whole-tree check, a hard reset, a clean tracker or start check followed by
 * the start checkout, or a conflicted continue that commits the checked index.
 * Each step keeps it true for its result. It is valid only inside the
 * synchronous call that proved it.
 */
export interface RebaseBaselineProof {
  readonly parentOid: string;
}
