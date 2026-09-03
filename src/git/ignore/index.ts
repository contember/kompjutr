// `.gitignore` handling. Rules are loaded in bounded pages and evaluated in JS.

import { type IgnoreMatcher, WorktreeIgnoreMatcher } from "./matcher.js";
import { type IgnoreWorktree, loadRules } from "./source.js";

export { IGNORE_LIMITS, IgnoreLimitError, type IgnoreLimitResource } from "./limits.js";
export {
  type IgnoreMatcher,
  type IgnoreSourceHashStep,
  type IgnoreSourceIndexStats,
  includeEverything,
  WorktreeIgnoreMatcher,
} from "./matcher.js";
export type { IgnorePattern } from "./pattern.js";
export { parseIgnoreFile } from "./source.js";

export interface IgnoreOptions {
  /** Extra patterns applied at the repository root, lowest precedence. */
  extra?: string[];
  /** Absolute roots owned by other repositories, excluded from discovery. */
  excludeRoots?: readonly string[];
}

export function loadIgnoreMatcher(
  worktree: IgnoreWorktree,
  root: string,
  options: IgnoreOptions = {},
): IgnoreMatcher {
  const loaded = loadRules(worktree, root, options.extra ?? [], options.excludeRoots ?? []);
  return new WorktreeIgnoreMatcher(loaded.rules, loaded.extra);
}
