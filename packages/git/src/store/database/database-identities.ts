import { CorruptError, GitError } from "../../common/errors.js";
import type { RepositoryLifecycle } from "../core/contracts.js";
import type { DatabaseState } from "./database-state.js";
import {
  CHECKOUT_LIFECYCLE_CARDINALITY_SQL,
  requireCheckoutLifecycleCardinality,
  requireSafeId,
  requireStoredCheckoutLifecycle,
  requireStoredRepositoryLifecycle,
  type StoredCheckoutLifecycle,
  type StoredRepositoryLifecycle,
} from "./lifecycle.js";

export class DatabaseIdentities {
  constructor(private readonly state: DatabaseState) {}

  insertRepository(lifecycle: RepositoryLifecycle, cloneExpiresMs: number | null): number {
    const row = this.state.db.one<Record<string, unknown>>(
      `INSERT INTO git_repositories (lifecycle, clone_expires_ms) VALUES (?, ?)
       RETURNING id`,
      lifecycle,
      cloneExpiresMs,
    );
    return requireSafeId(row?.id, "inserted repository id");
  }

  insertCheckout(repoId: number, root: string, head: string, isPrimary: boolean): number {
    const row = this.state.db.one<Record<string, unknown>>(
      `INSERT INTO git_checkouts (repo_id, root, head, is_primary) VALUES (?, ?, ?, ?)
       RETURNING id`,
      repoId,
      root,
      head,
      isPrimary ? 1 : 0,
    );
    return requireSafeId(row?.id, "inserted checkout id");
  }

  repositoryAtRoot(root: string): StoredCheckoutLifecycle | null {
    const row = this.state.db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
                checkout.head,
                checkout.is_primary, repository.lifecycle,
                repository.clone_expires_ms,
                ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
           FROM git_checkouts checkout
           JOIN git_repositories repository ON repository.id = checkout.repo_id
          WHERE checkout.root = ?`,
      root,
    );
    if (row === undefined) return null;
    const stored = requireStoredCheckoutLifecycle(row);
    requireCheckoutLifecycleCardinality(row, stored);
    return stored;
  }

  requireReadyRepository(repoId: number): StoredRepositoryLifecycle {
    const row = this.state.db.one<Record<string, unknown>>(
      `SELECT id AS repo_id, lifecycle, clone_expires_ms
         FROM git_repositories WHERE id = ?`,
      repoId,
    );
    if (row === undefined) throw new GitError("ENOTFOUND", "repository does not exist");
    const stored = requireStoredRepositoryLifecycle(row);
    if (stored.repoId !== repoId) {
      throw new CorruptError("repository lookup returned another repository");
    }
    if (stored.lifecycle !== "ready") {
      throw new GitError("ENOTFOUND", "repository is not published");
    }
    return stored;
  }
}
