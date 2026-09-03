import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import { CheckoutStore } from "./checkout.js";
import type { CheckoutRow, ProvisionalCloneOwner } from "./contracts.js";
import type { DatabaseIdentities } from "./database-identities.js";
import type { DatabaseRegistry } from "./database-registry.js";
import {
  checkoutRootInput,
  type DatabaseState,
  isLifecycleMutationCheckout,
  type ProvisionalStoreRecord,
  withLifecycleCheckoutMutations,
} from "./database-state.js";
import { isThenableResult } from "./json-pages.js";
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
import { requireRawRefTarget } from "./ref-validation.js";
import { SharedRepoStore } from "./shared.js";

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
    let cleanupGeneration: number | null = null;
    let created: {
      checkout: CheckoutRow;
      generation: number;
      evictedGeneration: number | null;
    };
    try {
      created = this.state.db.transactionSync(() => {
        const existing = this.identities.repositoryAtRoot(normalized);
        let evictedGeneration: number | null = null;
        if (existing !== null) {
          if (existing.lifecycle === "ready") {
            throw new GitError("EALREADYINIT", `repository already exists at ${normalized}`);
          }
          const oldGeneration = existing.cloneGeneration;
          const oldExpiry = existing.cloneExpiresMs;
          if (oldGeneration === null || oldExpiry === null) {
            throw new CorruptError("provisional clone owner is incomplete");
          }
          if (nowMs < oldExpiry) {
            throw new GitError("EBUSY", `clone at ${normalized} is still in progress`);
          }
          cleanupGeneration = oldGeneration;
          const oldStore = this.provisionalStore(existing.checkout, oldGeneration).store;
          const result = withLifecycleCheckoutMutations(oldStore, () => cleanup(oldStore));
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "provisional clone cleanup must be synchronous");
          }
          const deleted = this.state.db.one<Record<string, unknown>>(
            `DELETE FROM git_repositories
            WHERE id = ? AND lifecycle = 'provisional'
              AND clone_generation = ? AND clone_expires_ms = ? AND clone_expires_ms <= ?
          RETURNING id AS repo_id`,
            existing.repoId,
            oldGeneration,
            oldExpiry,
            nowMs,
          );
          if (
            deleted === undefined ||
            requireSafeId(deleted.repo_id, "deleted provisional repository id") !== existing.repoId
          ) {
            throw new GitError("ESTALE", "provisional clone ownership changed during takeover");
          }
          evictedGeneration = oldGeneration;
        }

        const identity = this.identities.allocateIdentities(true, true, true);
        this.state.db.run(
          `INSERT INTO git_repositories
             (id, lifecycle, clone_generation, clone_expires_ms)
           VALUES (?, 'provisional', ?, ?)`,
          identity.repoId,
          identity.cloneGeneration,
          expiresMs,
        );
        this.state.db.run(
          `INSERT INTO git_pack_ingest_control
             (repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms)
           VALUES (?, 0, 0, NULL, NULL)`,
          identity.repoId,
        );
        this.state.db.run(
          `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
           VALUES (?, ?, ?, ?, 1)`,
          identity.checkoutId,
          identity.repoId,
          normalized,
          checkedHead,
        );
        advanceCheckoutRevision(this.state.db, identity.repoId);
        this.state.db.run(
          "INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (?, 0)",
          identity.repoId,
        );
        this.state.db.run(
          `INSERT OR IGNORE INTO git_index_state
               (checkout_id, baseline_tree_oid, format, complete) VALUES (?, NULL, 1, 0)`,
          identity.checkoutId,
        );
        const checkout: CheckoutRow = {
          id: identity.checkoutId,
          repoId: identity.repoId,
          root: normalized,
          head: checkedHead,
          isPrimary: true,
        };
        return { checkout, generation: identity.cloneGeneration, evictedGeneration };
      });
    } catch (error) {
      if (cleanupGeneration !== null) {
        this.evictProvisional(cleanupGeneration);
      }
      throw error;
    }

    if (created.evictedGeneration !== null) {
      this.evictProvisional(created.evictedGeneration);
    }
    const checkout = Object.freeze(created.checkout);
    const record = this.provisionalStore(checkout, created.generation);
    const owner = Object.freeze({
      checkout,
      generation: created.generation,
      store: record.store,
    });
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
              AND clone_generation = ? AND clone_expires_ms = ? AND clone_expires_ms > ?
          RETURNING clone_expires_ms`,
          nextExpiry,
          stored.repoId,
          owner.generation,
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
              SET lifecycle = 'ready', clone_generation = NULL, clone_expires_ms = NULL
            WHERE id = ? AND lifecycle = 'provisional'
              AND clone_generation = ? AND clone_expires_ms = ? AND clone_expires_ms > ?
          RETURNING id AS repo_id, lifecycle, clone_generation, clone_expires_ms`,
          stored.repoId,
          owner.generation,
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
        const generation = owner.generation;
        const existing = this.state.provisionalStores.get(generation);
        if (existing !== undefined && existing.store !== owner.store) {
          throw new GitError("ESTALE", "provisional clone facade belongs to another owner");
        }
        cleanupRecord = existing ?? this.provisionalStore(stored.checkout, generation);
        const cleanupStore = cleanupRecord.store;
        const result = withLifecycleCheckoutMutations(cleanupStore, () => cleanup(cleanupStore));
        if (isThenableResult(result)) {
          void Promise.resolve(result).catch(() => {});
          throw new GitError("EINVAL", "provisional clone cleanup must be synchronous");
        }
        const deleted = this.state.db.one<Record<string, unknown>>(
          `DELETE FROM git_repositories
            WHERE id = ? AND lifecycle = 'provisional'
              AND clone_generation = ?
          RETURNING id AS repo_id`,
          stored.repoId,
          generation,
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
    const generation = requireSafeId(owner.generation, "provisional clone generation");
    const row = this.state.db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
                checkout.head,
                checkout.is_primary, repository.lifecycle,
                repository.clone_generation, repository.clone_expires_ms,
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
      stored.cloneGeneration !== generation ||
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
    const generation = owner.generation;
    const expiry = stored.cloneExpiresMs;
    if (expiry === null) throw new CorruptError("provisional clone lease is missing");
    if (nowMs >= expiry) throw new GitError("ESTALE", "provisional clone lease has expired");
    const record = this.state.provisionalStores.get(generation);
    if (record === undefined || record.store !== owner.store) {
      throw new GitError("ESTALE", "provisional clone facade is no longer active");
    }
    if (record.repoId !== stored.repoId || record.checkoutId !== stored.checkout.id) {
      throw new CorruptError("provisional clone facade has mismatched identity");
    }
    return stored;
  }

  private provisionalStore(checkout: CheckoutRow, generation: number): ProvisionalStoreRecord {
    const existing = this.state.provisionalStores.get(generation);
    if (existing !== undefined) {
      if (existing.repoId !== checkout.repoId || existing.checkoutId !== checkout.id) {
        throw new CorruptError("provisional clone generation belongs to another repository");
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
      generation,
      repoId: checkout.repoId,
      checkoutId: checkout.id,
      shared,
      store,
      lifetime,
    };
    this.state.provisionalStores.set(generation, record);
    return record;
  }

  private evictProvisional(generation: number): void {
    const record = this.state.provisionalStores.get(generation);
    if (record === undefined) return;
    this.evictProvisionalRecord(record);
  }

  private evictProvisionalRecord(record: ProvisionalStoreRecord): void {
    if (this.state.provisionalStores.get(record.generation) !== record) return;
    record.lifetime.revoke();
    record.shared.clearCaches();
    this.state.provisionalStores.delete(record.generation);
  }

  private provisionalRecordForOwner(owner: ProvisionalCloneOwner): ProvisionalStoreRecord | null {
    if (!this.state.issuedProvisionalOwners.has(owner)) return null;
    if (!Number.isSafeInteger(owner.generation) || owner.generation < 1) return null;
    const record = this.state.provisionalStores.get(owner.generation);
    return record !== undefined && record.store === owner.store ? record : null;
  }

  private evictProvisionalOwner(owner: ProvisionalCloneOwner): void {
    const record = this.provisionalRecordForOwner(owner);
    if (record === null) return;
    this.evictProvisionalRecord(record);
  }
}
