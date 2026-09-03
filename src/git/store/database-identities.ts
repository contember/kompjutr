import { CorruptError, GitError } from "../common/errors.js";
import type { DatabaseState } from "./database-state.js";
import {
  CHECKOUT_LIFECYCLE_CARDINALITY_SQL,
  nextIdentity,
  requireCheckoutLifecycleCardinality,
  requireIdentityCounter,
  requireStoredCheckoutLifecycle,
  requireStoredIdentityMaximum,
  requireStoredRepositoryLifecycle,
  type StoredCheckoutLifecycle,
  type StoredRepositoryLifecycle,
} from "./lifecycle.js";

interface AllocatedIdentity {
  repoId: number;
  checkoutId: number;
  cloneGeneration: number;
}

export class DatabaseIdentities {
  constructor(private readonly state: DatabaseState) {}

  readIdentityControl(): AllocatedIdentity {
    const row = this.state.db.one<Record<string, unknown>>(
      `SELECT control.singleton, control.last_repo_id, control.last_checkout_id,
              control.last_clone_generation,
              (SELECT MAX(id) FROM git_repositories) AS max_repo_id,
              (SELECT MAX(id) FROM git_checkouts) AS max_checkout_id,
              (SELECT MAX(clone_generation) FROM git_repositories) AS max_clone_generation
         FROM git_identity_control control WHERE control.singleton = 1`,
    );
    if (row === undefined || row.singleton !== 1) {
      throw new CorruptError("Git identity control singleton is missing");
    }
    const control: AllocatedIdentity = {
      repoId: requireIdentityCounter(row.last_repo_id, "last repository id"),
      checkoutId: requireIdentityCounter(row.last_checkout_id, "last checkout id"),
      cloneGeneration: requireIdentityCounter(row.last_clone_generation, "last clone generation"),
    };
    const maxRepoId = requireStoredIdentityMaximum(row.max_repo_id, "maximum repository id");
    const maxCheckoutId = requireStoredIdentityMaximum(row.max_checkout_id, "maximum checkout id");
    const maxCloneGeneration = requireStoredIdentityMaximum(
      row.max_clone_generation,
      "maximum clone generation",
    );
    if (
      maxRepoId > control.repoId ||
      maxCheckoutId > control.checkoutId ||
      maxCloneGeneration > control.cloneGeneration
    ) {
      throw new CorruptError("Git identity control trails stored identities");
    }
    return control;
  }

  allocateIdentities(
    allocateRepo: boolean,
    allocateCheckout: boolean,
    allocateClone: boolean,
  ): AllocatedIdentity {
    const previous = this.readIdentityControl();
    const next: AllocatedIdentity = {
      repoId: allocateRepo ? nextIdentity(previous.repoId, "repository id") : previous.repoId,
      checkoutId: allocateCheckout
        ? nextIdentity(previous.checkoutId, "checkout id")
        : previous.checkoutId,
      cloneGeneration: allocateClone
        ? nextIdentity(previous.cloneGeneration, "clone generation")
        : previous.cloneGeneration,
    };
    const updated = this.state.db.one<Record<string, unknown>>(
      `UPDATE git_identity_control
          SET last_repo_id = ?, last_checkout_id = ?, last_clone_generation = ?
        WHERE singleton = 1
          AND last_repo_id = ? AND last_checkout_id = ? AND last_clone_generation = ?
      RETURNING singleton, last_repo_id, last_checkout_id, last_clone_generation`,
      next.repoId,
      next.checkoutId,
      next.cloneGeneration,
      previous.repoId,
      previous.checkoutId,
      previous.cloneGeneration,
    );
    if (updated === undefined || updated.singleton !== 1) {
      throw new CorruptError("Git identity control changed during allocation");
    }
    const checked: AllocatedIdentity = {
      repoId: requireIdentityCounter(updated.last_repo_id, "allocated repository id"),
      checkoutId: requireIdentityCounter(updated.last_checkout_id, "allocated checkout id"),
      cloneGeneration: requireIdentityCounter(
        updated.last_clone_generation,
        "allocated clone generation",
      ),
    };
    if (
      checked.repoId !== next.repoId ||
      checked.checkoutId !== next.checkoutId ||
      checked.cloneGeneration !== next.cloneGeneration
    ) {
      throw new CorruptError("Git identity allocation returned unexpected counters");
    }
    return checked;
  }

  repositoryAtRoot(root: string): StoredCheckoutLifecycle | null {
    const row = this.state.db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
                checkout.head,
                checkout.is_primary, repository.lifecycle,
                repository.clone_generation, repository.clone_expires_ms,
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
      `SELECT id AS repo_id, lifecycle, clone_generation, clone_expires_ms
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
