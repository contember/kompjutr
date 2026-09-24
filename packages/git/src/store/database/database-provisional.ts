import { CorruptError, GitError, hasErrorCode } from "../../common/errors.js";
import { CheckoutStore } from "../checkout/checkout.js";
import type { CheckoutRow, ProvisionalCloneOwner } from "../core/contracts.js";
import { isThenableResult } from "../core/json-pages.js";
import { requireRawRefTarget } from "../refs/ref-validation.js";
import { SharedRepoStore } from "../repository/shared.js";
import type { DatabaseIdentities } from "./database-identities.js";
import type { DatabaseRegistry } from "./database-registry.js";
import {
  checkoutRootInput,
  type DatabaseState,
  isLifecycleMutationCheckout,
  type ProvisionalStoreRecord,
  withLifecycleCheckoutMutations,
} from "./database-state.js";
import {
  advanceCheckoutRevision,
  CHECKOUT_LIFECYCLE_CARDINALITY_SQL,
  CheckoutStoreLifetime,
  PROVISIONAL_CLONE_RENEW_WINDOW_MS,
  provisionalCloneExpiry,
  requireCheckoutLifecycleCardinality,
  requireMilliseconds,
  requireSafeId,
  requireStoredCheckoutLifecycle,
  requireStoredRepositoryLifecycle,
  type StoredCheckoutLifecycle,
} from "./lifecycle.js";

export class DatabaseProvisionalClones {
  constructor(
    private readonly state: DatabaseState,
    private readonly identities: DatabaseIdentities,
    private readonly registry: DatabaseRegistry,
  ) {}

  beginProvisionalCloneOwned(
    root: string,
    head: string,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): ProvisionalCloneOwner {
    const normalized = checkoutRootInput(root);
    const checkedHead = requireRawRefTarget(head, "initial HEAD target", "input");
    const nowMs = requireMilliseconds(now, "clone lease clock", "input");
    const expiresMs = provisionalCloneExpiry(nowMs);
    let cleanupRepoId: number | null = null;
    let created: {
      checkout: CheckoutRow;
      evictedRepoId: number | null;
    };
    try {
      created = this.state.db.transactionSync(() => {
        const existing = this.identities.repositoryAtRoot(normalized);
        let evictedRepoId: number | null = null;
        if (existing !== null) {
          if (existing.lifecycle === "ready") {
            throw new GitError("EALREADYINIT", `repository already exists at ${normalized}`);
          }
          const oldExpiry = existing.cloneExpiresMs;
          if (oldExpiry === null) {
            throw new CorruptError("provisional clone owner is incomplete");
          }
          if (nowMs < oldExpiry) {
            throw new GitError("EBUSY", `clone at ${normalized} is still in progress`);
          }
          cleanupRepoId = existing.repoId;
          const oldStore = this.provisionalStore(existing.checkout).store;
          const result = withLifecycleCheckoutMutations(oldStore, () => cleanup(oldStore));
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "provisional clone cleanup must be synchronous");
          }
          const deleted = this.state.db.one<Record<string, unknown>>(
            `DELETE FROM git_repositories
            WHERE id = ? AND lifecycle = 'provisional'
              AND clone_expires_ms = ? AND clone_expires_ms <= ?
          RETURNING id AS repo_id`,
            existing.repoId,
            oldExpiry,
            nowMs,
          );
          if (
            deleted === undefined ||
            requireSafeId(deleted.repo_id, "deleted provisional repository id") !== existing.repoId
          ) {
            throw new GitError("ESTALE", "provisional clone ownership changed during takeover");
          }
          evictedRepoId = existing.repoId;
        }

        const repoId = this.identities.insertRepository("provisional", expiresMs);
        this.state.db.run(
          `INSERT INTO git_pack_ingest_control
             (repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms)
           VALUES (?, 0, 0, NULL, NULL)`,
          repoId,
        );
        const checkoutId = this.identities.insertCheckout(repoId, normalized, checkedHead, true);
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
        const checkout: CheckoutRow = {
          id: checkoutId,
          repoId,
          root: normalized,
          head: checkedHead,
          isPrimary: true,
        };
        return { checkout, evictedRepoId };
      });
    } catch (error) {
      if (cleanupRepoId !== null) {
        this.evictProvisional(cleanupRepoId);
      }
      throw error;
    }

    if (created.evictedRepoId !== null) {
      this.evictProvisional(created.evictedRepoId);
    }
    const checkout = Object.freeze(created.checkout);
    const record = this.provisionalStore(checkout);
    const owner = Object.freeze({ checkout, store: record.store });
    this.state.issuedProvisionalOwners.add(owner);
    return owner;
  }

  renewProvisionalCloneOwned(owner: ProvisionalCloneOwner, now: number): number {
    const nowMs = requireMilliseconds(now, "clone lease clock", "input");
    try {
      return this.state.db.transactionSync(() => {
        const stored = this.requireProvisionalOwner(owner, nowMs);
        const currentExpiry = stored.cloneExpiresMs;
        if (currentExpiry === null) throw new CorruptError("provisional clone lease is missing");
        if (currentExpiry - nowMs > PROVISIONAL_CLONE_RENEW_WINDOW_MS) return currentExpiry;
        const nextExpiry = provisionalCloneExpiry(nowMs);
        const updated = this.state.db.one<Record<string, unknown>>(
          `UPDATE git_repositories SET clone_expires_ms = ?
            WHERE id = ? AND lifecycle = 'provisional'
              AND clone_expires_ms = ? AND clone_expires_ms > ?
          RETURNING clone_expires_ms`,
          nextExpiry,
          stored.repoId,
          currentExpiry,
          nowMs,
        );
        if (updated === undefined) {
          throw new GitError("ESTALE", "provisional clone ownership changed during renewal");
        }
        const checked = requireMilliseconds(
          updated.clone_expires_ms,
          "renewed clone lease expiry",
          "stored",
        );
        if (checked !== nextExpiry) {
          throw new CorruptError("clone lease renewal returned an unexpected expiry");
        }
        return checked;
      });
    } catch (error) {
      if (hasErrorCode(error, "ESTALE")) this.evictProvisionalOwner(owner);
      throw error;
    }
  }

  publishProvisionalCloneOwned(
    owner: ProvisionalCloneOwner,
    now: number,
    prepare?: (store: CheckoutStore) => undefined,
  ): CheckoutRow {
    const nowMs = requireMilliseconds(now, "clone lease clock", "input");
    let prepareStarted = false;
    let synchronousPrepareFailure = false;
    try {
      const published = this.state.db.transactionSync(() => {
        const stored = this.requireProvisionalOwner(owner, nowMs);
        const expiry = stored.cloneExpiresMs;
        if (expiry === null) throw new CorruptError("provisional clone lease is missing");
        if (prepare !== undefined) {
          prepareStarted = true;
          let result: undefined;
          try {
            result = withLifecycleCheckoutMutations(owner.store, () => prepare(owner.store));
          } catch (error) {
            synchronousPrepareFailure = true;
            throw error;
          }
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "provisional clone preparation must be synchronous");
          }
        }
        const updated = this.state.db.one<Record<string, unknown>>(
          `UPDATE git_repositories
              SET lifecycle = 'ready', clone_expires_ms = NULL
            WHERE id = ? AND lifecycle = 'provisional'
              AND clone_expires_ms = ? AND clone_expires_ms > ?
          RETURNING id AS repo_id, lifecycle, clone_expires_ms`,
          stored.repoId,
          expiry,
          nowMs,
        );
        if (updated === undefined) {
          throw new GitError("ESTALE", "provisional clone ownership changed before publication");
        }
        const lifecycle = requireStoredRepositoryLifecycle(updated);
        if (lifecycle.repoId !== stored.repoId || lifecycle.lifecycle !== "ready") {
          throw new CorruptError("clone publication returned an unexpected repository");
        }
        return stored.checkout;
      });
      this.evictProvisionalOwner(owner);
      this.state.issuedProvisionalOwners.delete(owner);
      return this.registry.rememberCheckout(published, true);
    } catch (error) {
      const record = this.provisionalRecordForOwner(owner);
      if (synchronousPrepareFailure && record !== null) {
        // The rollback preserves this exact owner for the bounded native-to-fallback retry.
        record.shared.revalidateStorageCaches();
      } else if (prepareStarted || hasErrorCode(error, "ESTALE")) {
        this.evictProvisionalOwner(owner);
      }
      throw error;
    }
  }

  discardProvisionalCloneOwned(
    owner: ProvisionalCloneOwner,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): void {
    requireMilliseconds(now, "clone lease clock", "input");
    let cleanupRecord: ProvisionalStoreRecord | null = null;
    try {
      this.state.db.transactionSync(() => {
        const stored = this.storedProvisionalOwner(owner);
        const existing = this.state.provisionalStores.get(stored.repoId);
        if (existing !== undefined && existing.store !== owner.store) {
          throw new GitError("ESTALE", "provisional clone facade belongs to another owner");
        }
        cleanupRecord = existing ?? this.provisionalStore(stored.checkout);
        const cleanupStore = cleanupRecord.store;
        const result = withLifecycleCheckoutMutations(cleanupStore, () => cleanup(cleanupStore));
        if (isThenableResult(result)) {
          void Promise.resolve(result).catch(() => {});
          throw new GitError("EINVAL", "provisional clone cleanup must be synchronous");
        }
        const deleted = this.state.db.one<Record<string, unknown>>(
          `DELETE FROM git_repositories
            WHERE id = ? AND lifecycle = 'provisional'
          RETURNING id AS repo_id`,
          stored.repoId,
        );
        if (
          deleted === undefined ||
          requireSafeId(deleted.repo_id, "discarded provisional repository id") !== stored.repoId
        ) {
          throw new GitError("ESTALE", "provisional clone ownership changed before discard");
        }
      });
    } catch (error) {
      if (cleanupRecord !== null) this.evictProvisionalRecord(cleanupRecord);
      else if (hasErrorCode(error, "ESTALE")) this.evictProvisionalOwner(owner);
      throw error;
    }
    if (cleanupRecord === null) {
      throw new CorruptError("provisional clone cleanup facade was not created");
    }
    this.evictProvisionalRecord(cleanupRecord);
    this.state.issuedProvisionalOwners.delete(owner);
  }

  private storedProvisionalOwner(owner: ProvisionalCloneOwner): StoredCheckoutLifecycle {
    if (!this.state.issuedProvisionalOwners.has(owner)) {
      throw new GitError("ESTALE", "provisional clone owner was not issued by this database");
    }
    const repoId = requireSafeId(owner.checkout.repoId, "provisional repository id");
    const checkoutId = requireSafeId(owner.checkout.id, "provisional checkout id");
    const row = this.state.db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
                checkout.head,
                checkout.is_primary, repository.lifecycle,
                repository.clone_expires_ms,
                ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
           FROM git_repositories repository
           JOIN git_checkouts checkout ON checkout.repo_id = repository.id
          WHERE repository.id = ? AND checkout.id = ? AND checkout.is_primary = 1`,
      repoId,
      checkoutId,
    );
    if (row === undefined) throw new GitError("ESTALE", "provisional clone owner is stale");
    const stored = requireStoredCheckoutLifecycle(row);
    if (
      stored.lifecycle !== "provisional" ||
      stored.checkout.root !== owner.checkout.root ||
      stored.checkout.repoId !== repoId ||
      stored.checkout.id !== checkoutId
    ) {
      throw new GitError("ESTALE", "provisional clone owner is stale");
    }
    requireCheckoutLifecycleCardinality(row, stored);
    return stored;
  }

  private requireProvisionalOwner(
    owner: ProvisionalCloneOwner,
    nowMs: number,
  ): StoredCheckoutLifecycle {
    const stored = this.storedProvisionalOwner(owner);
    const expiry = stored.cloneExpiresMs;
    if (expiry === null) throw new CorruptError("provisional clone lease is missing");
    if (nowMs >= expiry) throw new GitError("ESTALE", "provisional clone lease has expired");
    const record = this.state.provisionalStores.get(stored.repoId);
    if (record === undefined || record.store !== owner.store) {
      throw new GitError("ESTALE", "provisional clone facade is no longer active");
    }
    if (record.repoId !== stored.repoId || record.checkoutId !== stored.checkout.id) {
      throw new CorruptError("provisional clone facade has mismatched identity");
    }
    return stored;
  }

  private provisionalStore(checkout: CheckoutRow): ProvisionalStoreRecord {
    const existing = this.state.provisionalStores.get(checkout.repoId);
    if (existing !== undefined) {
      if (existing.checkoutId !== checkout.id) {
        throw new CorruptError("provisional clone facade belongs to another checkout");
      }
      return existing;
    }
    if (this.state.nextStoreGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new GitError("E2BIG", "repository store generation is exhausted");
    }
    const shared = new SharedRepoStore(
      this.state.db,
      checkout.repoId,
      this.state.nextStoreGeneration++,
      this.state.objects,
      this.state.packRows,
      this.state.options.now ?? Date.now,
      this.state.options,
    );
    const lifetime = new CheckoutStoreLifetime();
    const store = new CheckoutStore(
      shared,
      checkout,
      this.state.options,
      () => {
        throw new GitError("EINVAL", "provisional clone requires exact-owner discard");
      },
      lifetime,
      isLifecycleMutationCheckout,
    );
    const record: ProvisionalStoreRecord = {
      repoId: checkout.repoId,
      checkoutId: checkout.id,
      shared,
      store,
      lifetime,
    };
    this.state.provisionalStores.set(checkout.repoId, record);
    return record;
  }

  private evictProvisional(repoId: number): void {
    const record = this.state.provisionalStores.get(repoId);
    if (record === undefined) return;
    this.evictProvisionalRecord(record);
  }

  private evictProvisionalRecord(record: ProvisionalStoreRecord): void {
    if (this.state.provisionalStores.get(record.repoId) !== record) return;
    record.lifetime.revoke();
    record.shared.clearCaches();
    this.state.provisionalStores.delete(record.repoId);
  }

  private provisionalRecordForOwner(owner: ProvisionalCloneOwner): ProvisionalStoreRecord | null {
    if (!this.state.issuedProvisionalOwners.has(owner)) return null;
    const record = this.state.provisionalStores.get(owner.checkout.repoId);
    return record !== undefined && record.store === owner.store ? record : null;
  }

  private evictProvisionalOwner(owner: ProvisionalCloneOwner): void {
    const record = this.provisionalRecordForOwner(owner);
    if (record === null) return;
    this.evictProvisionalRecord(record);
  }
}
