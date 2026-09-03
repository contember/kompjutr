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

export const NO_REBASE_EXCLUSIONS: RebaseExclusions = { absolute: [], relative: [] };

export interface BaselineTransition {
  treeOid: string;
}
