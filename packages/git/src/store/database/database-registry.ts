import { CorruptError, GitError } from "../../common/errors.js";
import { CheckoutStore } from "../checkout/checkout.js";
import type { CheckoutRow } from "../core/contracts.js";
import { requireSafeRefLogInteger } from "../refs/reflog.js";
import { SharedRepoStore } from "../repository/shared.js";
import { MAX_CHECKOUTS_PER_REPOSITORY } from "../schema/schema.js";
import type { DatabaseIdentities } from "./database-identities.js";
import { type DatabaseState, isLifecycleMutationCheckout } from "./database-state.js";
import {
  CHECKOUT_LIFECYCLE_CARDINALITY_SQL,
  CheckoutStoreLifetime,
  requireCheckoutLifecycleCardinality,
  requireSafeId,
  requireStoredCheckoutLifecycle,
  requireStoredCheckoutRow,
} from "./lifecycle.js";

export class DatabaseRegistry {
  constructor(
    private readonly state: DatabaseState,
    private readonly identities: DatabaseIdentities,
    private readonly destroyRepositoryOwned: (repoId: number) => void,
  ) {}

  openShared(repoId: number): SharedRepoStore {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    this.identities.requireReadyRepository(repoId);
    const existing = this.state.sharedStores.get(repoId);
    if (existing !== undefined) return existing;
    const row = this.state.db.one<Record<string, unknown>>(
      `SELECT repository.id AS repo_id,
              count(checkout.id) AS checkout_count,
              coalesce(sum(checkout.is_primary), 0) AS primary_count
         FROM git_repositories repository
         LEFT JOIN git_checkouts checkout ON checkout.repo_id = repository.id
        WHERE repository.id = ? GROUP BY repository.id`,
      repoId,
    );
    if (row === undefined) throw new GitError("ENOTFOUND", "repository does not exist");
    if (requireSafeId(row.repo_id, "repository id") !== repoId) {
      throw new CorruptError("repository lookup returned another repository");
    }
    const checkoutCount = requireSafeRefLogInteger(
      row.checkout_count,
      "repository checkout count",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (checkoutCount > MAX_CHECKOUTS_PER_REPOSITORY) {
      throw new GitError("E2BIG", "repository exceeds 1,024 checkouts");
    }
    const primaryCount = requireSafeRefLogInteger(
      row.primary_count,
      "repository primary checkout count",
      0,
      checkoutCount,
    );
    if (primaryCount !== 1)
      throw new CorruptError("repository must have exactly one primary checkout");
    if (!Number.isSafeInteger(this.state.nextStoreGeneration)) {
      throw new GitError("E2BIG", "repository store generation is exhausted");
    }
    const generation = this.state.nextStoreGeneration++;
    const store = new SharedRepoStore(
      this.state.db,
      repoId,
      generation,
      this.state.objects,
      this.state.packRows,
      this.state.options.now ?? Date.now,
      this.state.options,
    );
    this.state.sharedStores.set(repoId, store);
    const primaryRaw = this.state.db.one<Record<string, unknown>>(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
         FROM git_checkouts WHERE repo_id = ? AND is_primary = 1`,
      repoId,
    );
    if (primaryRaw === undefined) throw new CorruptError("repository primary checkout is missing");
    const primary = requireStoredCheckoutRow(primaryRaw);
    if (primary.repoId !== repoId || !primary.isPrimary) {
      throw new CorruptError("repository primary checkout lookup returned another checkout");
    }
    // The non-removable primary keeps shared operations and pack callbacks live.
    const lifetime = new CheckoutStoreLifetime();
    const primaryStore = new CheckoutStore(
      store,
      primary,
      this.state.options,
      () => this.destroyRepositoryOwned(repoId),
      lifetime,
      isLifecycleMutationCheckout,
    );
    this.state.checkoutStores.set(primary.id, primaryStore);
    this.state.checkoutLifetimes.set(primary.id, lifetime);
    return store;
  }

  openCheckout(checkout: CheckoutRow | number): CheckoutStore {
    const checkoutId =
      typeof checkout === "number" ? checkout : requireSafeId(checkout.id, "checkout id");
    if (typeof checkout !== "number") this.rejectStaleCheckoutRow(checkout, checkoutId);
    const durable = this.checkoutById(checkoutId);
    if (
      typeof checkout !== "number" &&
      (checkout.repoId !== durable.repoId ||
        checkout.root !== durable.root ||
        checkout.isPrimary !== durable.isPrimary)
    ) {
      throw new CorruptError("checkout identity changed before it was opened");
    }
    const existing = this.state.checkoutStores.get(checkoutId);
    if (existing !== undefined) {
      if (
        typeof checkout !== "number" &&
        (checkout.repoId !== existing.sharedRepoId ||
          checkout.root !== existing.root ||
          checkout.isPrimary !== existing.isPrimary)
      ) {
        throw new CorruptError("cached checkout identity does not match its requested row");
      }
      return existing;
    }
    const stored = durable;
    const shared = this.openShared(stored.repoId);
    const installed = this.state.checkoutStores.get(checkoutId);
    if (installed !== undefined) return installed;
    const lifetime = new CheckoutStoreLifetime();
    const store = new CheckoutStore(
      shared,
      stored,
      this.state.options,
      () => this.destroyRepositoryOwned(stored.repoId),
      lifetime,
      isLifecycleMutationCheckout,
    );
    this.state.checkoutStores.set(checkoutId, store);
    this.state.checkoutLifetimes.set(checkoutId, lifetime);
    return store;
  }

  rememberCheckout(row: CheckoutRow, replaceIdentity = false): CheckoutRow {
    let generation = replaceIdentity ? undefined : this.state.checkoutRowGenerations.get(row.id);
    if (generation === undefined) {
      if (!Number.isSafeInteger(this.state.nextCheckoutRowGeneration)) {
        throw new GitError("E2BIG", "checkout row generation is exhausted");
      }
      generation = this.state.nextCheckoutRowGeneration++;
      this.state.checkoutRowGenerations.set(row.id, generation);
    }
    const remembered = Object.freeze(row);
    this.state.validatedCheckoutRows.set(remembered, generation);
    return remembered;
  }

  requireCheckoutsIdle(repoId: number, checkoutIds: readonly number[]): void {
    if (checkoutIds.length === 0) return;
    const row = this.state.db.one<Record<string, unknown>>(
      `SELECT operation.checkout_id
         FROM git_operation_state operation
         JOIN git_checkouts checkout ON checkout.id = operation.checkout_id
        WHERE checkout.repo_id = ?
          AND operation.checkout_id IN (SELECT value FROM json_each(?))
        LIMIT 1`,
      repoId,
      JSON.stringify(checkoutIds),
    );
    if (row === undefined) return;
    const busyId = requireSafeId(row.checkout_id, "busy checkout id");
    if (!checkoutIds.includes(busyId)) {
      throw new CorruptError("checkout operation probe returned another checkout");
    }
    throw new GitError("EWORKTREEBUSY", `checkout ${busyId} has a live operation`);
  }

  evictCheckout(checkoutId: number): void {
    this.state.checkoutLifetimes.get(checkoutId)?.revoke();
    this.state.checkoutLifetimes.delete(checkoutId);
    this.state.checkoutStores.delete(checkoutId);
    this.state.checkoutRowGenerations.delete(checkoutId);
  }

  private checkoutById(checkoutId: number): CheckoutRow {
    const raw = this.state.db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
                checkout.head,
                checkout.is_primary, repository.lifecycle,
                repository.clone_generation, repository.clone_expires_ms,
                ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
           FROM git_checkouts checkout
           JOIN git_repositories repository ON repository.id = checkout.repo_id
          WHERE checkout.id = ?`,
      checkoutId,
    );
    if (raw === undefined) throw new GitError("ENOTFOUND", "checkout does not exist");
    const stored = requireStoredCheckoutLifecycle(raw);
    requireCheckoutLifecycleCardinality(raw, stored);
    if (stored.lifecycle !== "ready") {
      throw new GitError("ENOTFOUND", "checkout is not published");
    }
    return stored.checkout;
  }

  private rejectStaleCheckoutRow(checkout: CheckoutRow, checkoutId: number): void {
    const rememberedGeneration = this.state.validatedCheckoutRows.get(checkout);
    if (
      rememberedGeneration !== undefined &&
      rememberedGeneration !== this.state.checkoutRowGenerations.get(checkoutId)
    ) {
      throw new GitError("EWORKTREENOTFOUND", "checkout identity is no longer active");
    }
  }
}
