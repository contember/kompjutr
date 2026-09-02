import { sqliteGitDatabaseMutations } from "../store/database.js";
import { sharedRepoStoreMutations } from "../store/shared.js";
// Creating a repository. There is no directory to make and no template to
// copy: a repository is one row in `git_repositories` plus whatever refs
// and config follow.

import { AlreadyInitializedError } from "../common/errors.js";
import { normalizePath } from "../common/paths.js";
import type { GitContext } from "./context.js";
import { Repository } from "./repository.js";

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
  if (context.database.checkoutAt(root) !== null) throw new AlreadyInitializedError(root);
  const branch = options.defaultBranch ?? "main";
  const row = sqliteGitDatabaseMutations(context.database).createRepositoryOwned(
    root,
    `ref: refs/heads/${branch}`,
  );
  const repo = new Repository(context.database.openCheckout(row));
  if (options.bare === true)
    sharedRepoStoreMutations(repo.store).configSetOwned("core.bare", "true");
  return repo;
}
