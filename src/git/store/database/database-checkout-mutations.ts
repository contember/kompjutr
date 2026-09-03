import { CorruptError, GitError } from "../../common/errors.js";
import { CheckoutStore } from "../checkout/checkout.js";
import type { CheckoutRow } from "../core/contracts.js";
import { isThenableResult } from "../core/json-pages.js";
import { bumpMaintenanceRootEpoch } from "../maintenance/control.js";
import { rawSymbolicTarget, requireRawRefTarget } from "../refs/ref-validation.js";
import { MAX_CHECKOUTS_PER_REPOSITORY } from "../schema/schema.js";
import type { DatabaseIdentities } from "./database-identities.js";
import type { DatabaseRegistry } from "./database-registry.js";
import {
  checkoutRootInput,
  type DatabaseState,
  isLifecycleMutationCheckout,
  withLifecycleCheckoutMutations,
} from "./database-state.js";
import {
  advanceCheckoutRevision,
  CheckoutStoreLifetime,
  isAttachedBranchUniqueConstraint,
  isCheckoutRootUniqueConstraint,
  requireSafeId,
  requireStoredCheckoutRow,
} from "./lifecycle.js";

export class DatabaseCheckoutMutations {
  constructor(
    private readonly state: DatabaseState,
    private readonly identities: DatabaseIdentities,
    private readonly registry: DatabaseRegistry,
  ) {}

  createRepositoryOwned(root: string, head: string): CheckoutRow {
    const normalized = checkoutRootInput(root);
    const checkedHead = requireRawRefTarget(head, "initial HEAD target", "input");
    return this.state.db.transactionSync(() => {
      const existing = this.identities.repositoryAtRoot(normalized);
      if (existing !== null) {
        if (existing.lifecycle === "provisional") {
          throw new GitError("EBUSY", `clone at ${normalized} is still in progress`);
        }
        throw new GitError("EALREADYINIT", `repository already exists at ${normalized}`);
      }
      const identity = this.identities.allocateIdentities(true, true, false);
      const repoId = identity.repoId;
      const checkoutId = identity.checkoutId;
      try {
        this.state.db.run("INSERT INTO git_repositories (id) VALUES (?)", repoId);
      } catch (error) {
        throw new CorruptError("repository identity control precedes stored repositories", {
          cause: error,
        });
      }
      this.state.db.run(
        `INSERT INTO git_pack_ingest_control
           (repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms)
         VALUES (?, 0, 0, NULL, NULL)`,
        repoId,
      );
      this.state.db.run(
        `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
         VALUES (?, ?, ?, ?, 1)`,
        checkoutId,
        repoId,
        normalized,
        checkedHead,
      );
      advanceCheckoutRevision(this.state.db, repoId);
      this.state.db.run(
        "INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (?, 0)",
        repoId,
      );
      this.state.db.run(
        `INSERT OR IGNORE INTO git_index_state
           (checkout_id, baseline_tree_oid, format, complete) VALUES (?, NULL, 1, 0)`,
        checkoutId,
      );
      return this.registry.rememberCheckout(
        {
          id: checkoutId,
          repoId,
          root: normalized,
          head: checkedHead,
          isPrimary: true,
        },
        true,
      );
    });
  }

  /** Create one non-primary checkout and initialize its private state atomically. */
  createCheckoutOwned(
    repoId: number,
    root: string,
    head: string,
    initialize?: (store: CheckoutStore) => undefined,
  ): CheckoutRow {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    const normalized = checkoutRootInput(root);
    const checkedHead = requireRawRefTarget(head, "initial HEAD target", "input");
    const attached = rawSymbolicTarget(checkedHead);
    const shared = this.registry.openShared(repoId);

    const lifetime = new CheckoutStoreLifetime();
    let created: {
      row: CheckoutRow;
      store: CheckoutStore;
      lifetime: CheckoutStoreLifetime;
    };
    try {
      created = this.state.db.transactionSync(() => {
        const count = this.state.db.scalar<unknown>(
          "SELECT count(*) FROM git_checkouts WHERE repo_id = ?",
          repoId,
        );
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
          throw new CorruptError("repository checkout count is invalid");
        }
        if (count >= MAX_CHECKOUTS_PER_REPOSITORY) {
          throw new GitError(
            "EWORKTREELIMIT",
            `repository already has ${MAX_CHECKOUTS_PER_REPOSITORY} checkouts`,
          );
        }

        const rootOwner = this.state.db.one<Record<string, unknown>>(
          `SELECT id AS checkout_id, repo_id, root, head, is_primary
             FROM git_checkouts WHERE root = ?`,
          normalized,
        );
        if (rootOwner !== undefined) {
          const owner = requireStoredCheckoutRow(rootOwner);
          if (owner.root !== normalized) {
            throw new CorruptError("checkout root lookup returned another root");
          }
          throw new GitError(
            "EWORKTREEEXISTS",
            `checkout root is already registered: ${normalized}`,
          );
        }
        if (attached?.startsWith("refs/heads/")) {
          const branchOwner = this.state.db.one<Record<string, unknown>>(
            `SELECT id AS checkout_id, repo_id, root, head, is_primary
                 FROM git_checkouts WHERE repo_id = ? AND head = ?`,
            repoId,
            checkedHead,
          );
          if (branchOwner !== undefined) {
            const owner = requireStoredCheckoutRow(branchOwner);
            if (owner.repoId !== repoId) {
              throw new CorruptError("attached branch lookup crossed repository boundaries");
            }
            if (owner.head !== checkedHead) {
              throw new CorruptError("attached branch lookup returned another branch");
            }
            throw new GitError(
              "EBRANCHINUSE",
              `branch ${attached} is already attached to checkout ${owner.root}`,
            );
          }
        }

        const checkoutId = this.identities.allocateIdentities(false, true, false).checkoutId;
        try {
          this.state.db.run(
            `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
           VALUES (?, ?, ?, ?, 0)`,
            checkoutId,
            repoId,
            normalized,
            checkedHead,
          );
        } catch (error) {
          if (isCheckoutRootUniqueConstraint(error)) {
            throw new GitError(
              "EWORKTREEEXISTS",
              `checkout root is already registered: ${normalized}`,
              { cause: error },
            );
          }
          if (isAttachedBranchUniqueConstraint(error)) {
            throw new GitError(
              "EBRANCHINUSE",
              `branch ${attached ?? checkedHead} is already attached to another checkout`,
              { cause: error },
            );
          }
          throw error;
        }
        advanceCheckoutRevision(this.state.db, repoId);
        this.state.db.run(
          `INSERT OR IGNORE INTO git_index_state
           (checkout_id, baseline_tree_oid, format, complete) VALUES (?, NULL, 1, 0)`,
          checkoutId,
        );
        const initial: CheckoutRow = {
          id: checkoutId,
          repoId,
          root: normalized,
          head: checkedHead,
          isPrimary: false,
        };
        const store = new CheckoutStore(
          shared,
          initial,
          this.state.options,
          () => this.destroyRepositoryOwned(repoId),
          lifetime,
          isLifecycleMutationCheckout,
        );
        if (initialize !== undefined) {
          const result = withLifecycleCheckoutMutations(store, () => initialize(store));
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "checkout initialization must be synchronous");
          }
        }
        bumpMaintenanceRootEpoch(this.state.db, repoId);
        return { row: { ...initial, head: store.head() }, store, lifetime };
      });
    } catch (error) {
      lifetime.revoke();
      shared.revalidateStorageCaches();
      throw error;
    }

    const remembered = this.registry.rememberCheckout(created.row, true);
    this.state.checkoutStores.set(remembered.id, created.store);
    this.state.checkoutLifetimes.set(remembered.id, created.lifetime);
    return remembered;
  }

  /** Remove one non-primary checkout after the caller deletes its root. */
  removeCheckoutOwned(
    checkoutId: number,
    removeRoot: (checkout: CheckoutRow) => undefined,
  ): CheckoutRow {
    if (!Number.isSafeInteger(checkoutId) || checkoutId < 1) {
      throw new GitError("EINVAL", "checkout id must be a safe positive integer");
    }
    const removed = this.state.db.transactionSync(() => {
      const raw = this.state.db.one<Record<string, unknown>>(
        `SELECT id AS checkout_id, repo_id, root, head, is_primary
           FROM git_checkouts WHERE id = ?`,
        checkoutId,
      );
      if (raw === undefined) throw new GitError("EWORKTREENOTFOUND", "checkout does not exist");
      const row = requireStoredCheckoutRow(raw);
      if (row.id !== checkoutId) throw new CorruptError("checkout lookup returned another row");
      if (row.isPrimary) {
        throw new GitError("EPRIMARYWORKTREE", "the primary checkout cannot be removed");
      }
      this.registry.requireCheckoutsIdle(row.repoId, [row.id]);
      advanceCheckoutRevision(this.state.db, row.repoId);
      const callbackStore = this.registry.openCheckout(row);
      const result = withLifecycleCheckoutMutations(callbackStore, () =>
        removeRoot(Object.freeze(row)),
      );
      if (isThenableResult(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new GitError("EINVAL", "checkout removal must be synchronous");
      }
      const deleted = this.state.db.one<Record<string, unknown>>(
        `DELETE FROM git_checkouts
          WHERE id = ? AND repo_id = ? AND is_primary = 0
          RETURNING id AS checkout_id`,
        row.id,
        row.repoId,
      );
      if (
        deleted === undefined ||
        requireSafeId(deleted.checkout_id, "deleted checkout id") !== row.id
      ) {
        throw new CorruptError("checkout disappeared during removal");
      }
      bumpMaintenanceRootEpoch(this.state.db, row.repoId);
      return Object.freeze(row);
    });
    this.registry.evictCheckout(removed.id);
    return removed;
  }

  /** Remove a bounded set of non-primary checkouts in one atomic delete. */
  removeCheckoutsOwned(repoId: number, checkoutIds: readonly number[]): readonly CheckoutRow[] {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    if (checkoutIds.length > MAX_CHECKOUTS_PER_REPOSITORY) {
      throw new GitError("E2BIG", "checkout removal exceeds 1,024 inputs");
    }
    const uniqueIds: number[] = [];
    const seen = new Set<number>();
    for (const checkoutId of checkoutIds) {
      if (!Number.isSafeInteger(checkoutId) || checkoutId < 1) {
        throw new GitError("EINVAL", "checkout id must be a safe positive integer");
      }
      if (!seen.has(checkoutId)) {
        seen.add(checkoutId);
        uniqueIds.push(checkoutId);
      }
    }
    if (uniqueIds.length === 0) return Object.freeze([]);
    this.registry.openShared(repoId);
    const idsJson = JSON.stringify(uniqueIds);
    const removed = this.state.db.transactionSync(() => {
      const rows: CheckoutRow[] = [];
      const selectedIds = new Set<number>();
      for (const raw of this.state.db.iterate(
        `SELECT id AS checkout_id, repo_id, root, head, is_primary
           FROM git_checkouts
          WHERE id IN (SELECT value FROM json_each(?))
          ORDER BY root COLLATE BINARY
          LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
        idsJson,
      )) {
        const row = requireStoredCheckoutRow(raw);
        if (!seen.has(row.id)) {
          throw new CorruptError("checkout removal query returned an unrequested checkout");
        }
        if (selectedIds.has(row.id)) {
          throw new CorruptError("checkout removal query returned a duplicate checkout");
        }
        selectedIds.add(row.id);
        if (row.repoId !== repoId) {
          throw new GitError("EWORKTREENOTFOUND", "checkout belongs to another repository");
        }
        if (row.isPrimary) {
          throw new GitError("EPRIMARYWORKTREE", "the primary checkout cannot be removed");
        }
        rows.push(row);
      }
      if (rows.length > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new CorruptError("checkout removal query exceeded its bounded result");
      }
      if (rows.length === 0) return Object.freeze(rows);
      const existingIds = rows.map((row) => row.id);
      this.registry.requireCheckoutsIdle(repoId, existingIds);
      const existingJson = JSON.stringify(existingIds);
      const deleted = this.state.db.all<Record<string, unknown>>(
        `DELETE FROM git_checkouts
          WHERE repo_id = ? AND is_primary = 0
            AND id IN (SELECT value FROM json_each(?))
          RETURNING id AS checkout_id`,
        repoId,
        existingJson,
      );
      const deletedIds = new Set<number>();
      for (const row of deleted) {
        deletedIds.add(requireSafeId(row.checkout_id, "deleted checkout id"));
      }
      if (deletedIds.size !== rows.length || rows.some((row) => !deletedIds.has(row.id))) {
        throw new CorruptError("bulk checkout removal deleted an unexpected set");
      }
      advanceCheckoutRevision(this.state.db, repoId, rows.length);
      bumpMaintenanceRootEpoch(this.state.db, repoId);
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    });
    for (const row of removed) this.registry.evictCheckout(row.id);
    return removed;
  }

  destroyRepositoryOwned(repoId: number): void {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    this.identities.requireReadyRepository(repoId);
    this.state.db.run("DELETE FROM git_repositories WHERE id = ? AND lifecycle = 'ready'", repoId);
    const shared = this.state.sharedStores.get(repoId);
    shared?.clearCaches();
    this.state.sharedStores.delete(repoId);
    for (const [checkoutId, store] of this.state.checkoutStores) {
      if (store.sharedRepoId === repoId) this.registry.evictCheckout(checkoutId);
    }
  }
}
