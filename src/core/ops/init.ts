// Creating a repository. There is no directory to make and no template to
// copy: a repository is one row in `git_repositories` plus whatever refs
// and config follow.

import type { GitContext } from "../context.js";
import { AlreadyInitializedError } from "../errors.js";
import { normalizePath } from "../paths.js";
import { Repository } from "../repository.js";

export interface InitOptions {
  dir?: string;
  /** Branch HEAD points at before the first commit. */
  defaultBranch?: string;
  /**
   * Accepted for interface compatibility. Every repository here is
   * effectively bare — the object database is never on disk — so this only
   * records the caller's intent.
   */
  bare?: boolean;
}

export function initRepository(context: GitContext, options: InitOptions = {}): Repository {
  const root = normalizePath(options.dir ?? "/");
  if (context.database.at(root) !== null) throw new AlreadyInitializedError(root);
  const branch = options.defaultBranch ?? "main";
  const row = context.database.create(root, `ref: refs/heads/${branch}`);
  const repo = new Repository(context.database.open(row), row.root);
  if (options.bare === true) repo.store.configSet("core.bare", "true");
  return repo;
}
