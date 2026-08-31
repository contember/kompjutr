// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import type { SqlDatabase } from "../../db/db.js";
import {
  MAX_ROUTING_CHECKOUTS,
  MAX_ROUTING_CHECKOUTS_RETAINED_BYTES,
  MAX_ROUTING_ROOTS_UTF8_BYTES,
} from "../../db/routing.js";
import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import { ByteLru } from "../common/lru.js";
import type { RawObject } from "../common/objects.js";
import { CheckoutStore, DEFAULT_OBJECT_CACHE_BYTES } from "./checkout.js";
import type { CheckoutRow, ProvisionalCloneOwner, StoreOptions } from "./contracts.js";
import { isThenableResult, utf8ByteLength } from "./json-pages.js";
import {
  advanceCheckoutRevision,
  CHECKOUT_LIFECYCLE_CARDINALITY_SQL,
  CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES,
  CheckoutStoreLifetime,
  enforceForeignKeys,
  isAttachedBranchUniqueConstraint,
  isCheckoutRootUniqueConstraint,
  nextIdentity,
  PROVISIONAL_CLONE_RENEW_WINDOW_MS,
  provisionalCloneExpiry,
  requireCheckoutLifecycleCardinality,
  requireCheckoutRoot,
  requireCheckoutRootInput,
  requireIdentityCounter,
  requireMilliseconds,
  requireSafeId,
  requireStoredCheckoutLifecycle,
  requireStoredCheckoutRow,
  requireStoredIdentityMaximum,
  requireStoredRepositoryLifecycle,
  type StoredCheckoutLifecycle,
  type StoredRepositoryLifecycle,
} from "./lifecycle.js";
import { bumpMaintenanceRootEpoch } from "./maintenance/control.js";
import {
  advanceMaintenanceRootSnapshot as advanceRootSnapshot,
  type MaintenanceRootSnapshotProgress,
  validatedOperationJournalRoots,
} from "./maintenance/roots.js";
import { readOperationStateOwned } from "./operation-journal.js";
import { MAX_PACK_ROW_CACHE_BYTES } from "./packs.js";
import { rawSymbolicTarget, requireRawRefTarget } from "./ref-validation.js";
import { requireSafeRefLogInteger } from "./reflog.js";
import { initializeGitSchema, MAX_CHECKOUTS_PER_REPOSITORY } from "./schema.js";
import { SharedRepoStore } from "./shared.js";

interface ProvisionalStoreRecord {
  generation: number;
  repoId: number;
  checkoutId: number;
  shared: SharedRepoStore;
  store: CheckoutStore;
  lifetime: CheckoutStoreLifetime;
}

interface AllocatedIdentity {
  repoId: number;
  checkoutId: number;
  cloneGeneration: number;
}

interface MaintenanceRootAdvanceOptions {
  nowMs: number;
  pageRows?: number;
}

type OwnedMaintenanceRootAdvancer = (
  repoId: number,
  options: MaintenanceRootAdvanceOptions,
) => MaintenanceRootSnapshotProgress;

const OWNED_MAINTENANCE_ROOT_ADVANCERS = new WeakMap<object, OwnedMaintenanceRootAdvancer>();

type OwnedCheckoutLister = (repoId: number) => readonly CheckoutRow[];

const OWNED_CHECKOUT_LISTERS = new WeakMap<object, OwnedCheckoutLister>();

/** Owns the schema plus shared-store and checkout facade registries. */
export class SqliteGitDatabase {
  readonly #db: SqlDatabase;
  readonly #options: StoreOptions;
  readonly #sharedStores = new Map<number, SharedRepoStore>();
  readonly #checkoutStores = new Map<number, CheckoutStore>();
  readonly #checkoutLifetimes = new Map<number, CheckoutStoreLifetime>();
  readonly #validatedCheckoutRows = new WeakMap<CheckoutRow, number>();
  readonly #checkoutRowGenerations = new Map<number, number>();
  readonly #provisionalStores = new Map<number, ProvisionalStoreRecord>();
  readonly #issuedProvisionalOwners = new WeakSet<ProvisionalCloneOwner>();
  readonly #objects: ByteLru<string, RawObject>;
  readonly #packRows: ByteLru<string, Uint8Array>;
  #nextStoreGeneration = 1;
  #nextCheckoutRowGeneration = 1;

  constructor(db: SqlDatabase, options: StoreOptions = {}) {
    this.#db = db;
    this.#options = options;
    this.#objects = new ByteLru(
      Math.min(options.objectCacheBytes ?? DEFAULT_OBJECT_CACHE_BYTES, DEFAULT_OBJECT_CACHE_BYTES),
      (object) => object.data.length,
    );
    this.#packRows = new ByteLru(
      Math.min(options.chunkBytes ?? MAX_PACK_ROW_CACHE_BYTES, MAX_PACK_ROW_CACHE_BYTES),
      (row) => row.length,
    );
    enforceForeignKeys(db);
    initializeGitSchema(db);
    this.#readIdentityControl();
    OWNED_MAINTENANCE_ROOT_ADVANCERS.set(this, (repoId, rootOptions) =>
      this.#advanceMaintenanceRootSnapshot(repoId, rootOptions),
    );
    OWNED_CHECKOUT_LISTERS.set(this, (repoId) => this.#listCheckoutsOwned(repoId));
  }

  get db(): SqlDatabase {
    return this.#db;
  }

  #checkoutRootInput(root: unknown): string {
    const checkedInput = requireCheckoutRootInput(root);
    return requireCheckoutRoot(checkedInput, "input");
  }

  #readIdentityControl(): AllocatedIdentity {
    const row = this.#db.one<Record<string, unknown>>(
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

  #allocateIdentities(
    allocateRepo: boolean,
    allocateCheckout: boolean,
    allocateClone: boolean,
  ): AllocatedIdentity {
    const previous = this.#readIdentityControl();
    const next: AllocatedIdentity = {
      repoId: allocateRepo ? nextIdentity(previous.repoId, "repository id") : previous.repoId,
      checkoutId: allocateCheckout
        ? nextIdentity(previous.checkoutId, "checkout id")
        : previous.checkoutId,
      cloneGeneration: allocateClone
        ? nextIdentity(previous.cloneGeneration, "clone generation")
        : previous.cloneGeneration,
    };
    const updated = this.#db.one<Record<string, unknown>>(
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

  #repositoryAtRoot(root: string): StoredCheckoutLifecycle | null {
    const row = this.#db.one<Record<string, unknown>>(
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

  #requireReadyRepository(repoId: number): StoredRepositoryLifecycle {
    const row = this.#db.one<Record<string, unknown>>(
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

  #storedProvisionalOwner(owner: ProvisionalCloneOwner): StoredCheckoutLifecycle {
    if (!this.#issuedProvisionalOwners.has(owner)) {
      throw new GitError("ESTALE", "provisional clone owner was not issued by this database");
    }
    const repoId = requireSafeId(owner.checkout.repoId, "provisional repository id");
    const checkoutId = requireSafeId(owner.checkout.id, "provisional checkout id");
    const generation = requireSafeId(owner.generation, "provisional clone generation");
    const row = this.#db.one<Record<string, unknown>>(
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

  #requireProvisionalOwner(owner: ProvisionalCloneOwner, nowMs: number): StoredCheckoutLifecycle {
    const stored = this.#storedProvisionalOwner(owner);
    const generation = owner.generation;
    const expiry = stored.cloneExpiresMs;
    if (expiry === null) throw new CorruptError("provisional clone lease is missing");
    if (nowMs >= expiry) throw new GitError("ESTALE", "provisional clone lease has expired");
    const record = this.#provisionalStores.get(generation);
    if (record === undefined || record.store !== owner.store) {
      throw new GitError("ESTALE", "provisional clone facade is no longer active");
    }
    if (record.repoId !== stored.repoId || record.checkoutId !== stored.checkout.id) {
      throw new CorruptError("provisional clone facade has mismatched identity");
    }
    return stored;
  }

  #provisionalStore(checkout: CheckoutRow, generation: number): ProvisionalStoreRecord {
    const existing = this.#provisionalStores.get(generation);
    if (existing !== undefined) {
      if (existing.repoId !== checkout.repoId || existing.checkoutId !== checkout.id) {
        throw new CorruptError("provisional clone generation belongs to another repository");
      }
      return existing;
    }
    if (this.#nextStoreGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new GitError("E2BIG", "repository store generation is exhausted");
    }
    const shared = new SharedRepoStore(
      this.#db,
      checkout.repoId,
      this.#nextStoreGeneration++,
      this.#objects,
      this.#packRows,
      this.#options.now ?? Date.now,
      this.#options,
    );
    const lifetime = new CheckoutStoreLifetime();
    const store = new CheckoutStore(
      shared,
      checkout,
      this.#options,
      () => {
        throw new GitError("EINVAL", "provisional clone requires exact-owner discard");
      },
      lifetime,
    );
    const record: ProvisionalStoreRecord = {
      generation,
      repoId: checkout.repoId,
      checkoutId: checkout.id,
      shared,
      store,
      lifetime,
    };
    this.#provisionalStores.set(generation, record);
    return record;
  }

  #evictProvisional(generation: number): void {
    const record = this.#provisionalStores.get(generation);
    if (record === undefined) return;
    this.#evictProvisionalRecord(record);
  }

  #evictProvisionalRecord(record: ProvisionalStoreRecord): void {
    if (this.#provisionalStores.get(record.generation) !== record) return;
    record.lifetime.revoke();
    record.shared.clearCaches();
    this.#provisionalStores.delete(record.generation);
  }

  #provisionalRecordForOwner(owner: ProvisionalCloneOwner): ProvisionalStoreRecord | null {
    if (!this.#issuedProvisionalOwners.has(owner)) return null;
    if (!Number.isSafeInteger(owner.generation) || owner.generation < 1) return null;
    const record = this.#provisionalStores.get(owner.generation);
    return record !== undefined && record.store === owner.store ? record : null;
  }

  #evictProvisionalOwner(owner: ProvisionalCloneOwner): void {
    const record = this.#provisionalRecordForOwner(owner);
    if (record === null) return;
    this.#evictProvisionalRecord(record);
  }

  /** The checkout whose root is the nearest registered ancestor of `dir`. */
  findCheckout(dir: string): CheckoutRow | null {
    const path = this.#checkoutRootInput(dir);
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
                checkout.head,
                checkout.is_primary, repository.lifecycle,
                repository.clone_generation, repository.clone_expires_ms,
                ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
           FROM git_checkouts checkout
           JOIN git_repositories repository ON repository.id = checkout.repo_id
          WHERE checkout.root = '/' OR checkout.root = ?
             OR substr(?, 1, length(checkout.root) + 1) = checkout.root || '/'
          ORDER BY length(CAST(checkout.root AS BLOB)) DESC, checkout.id DESC
          LIMIT 1`,
      path,
      path,
    );
    if (row === undefined) return null;
    const stored = requireStoredCheckoutLifecycle(row);
    requireCheckoutLifecycleCardinality(row, stored);
    return stored.lifecycle === "provisional" ? null : this.#rememberCheckout(stored.checkout);
  }

  checkoutAt(root: string): CheckoutRow | null {
    const checkedRoot = this.#checkoutRootInput(root);
    const row = this.#db.one<Record<string, unknown>>(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
                checkout.head,
                checkout.is_primary, repository.lifecycle,
                repository.clone_generation, repository.clone_expires_ms,
                ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
           FROM git_checkouts checkout
           JOIN git_repositories repository ON repository.id = checkout.repo_id
          WHERE checkout.root = ?`,
      checkedRoot,
    );
    if (row === undefined) return null;
    const stored = requireStoredCheckoutLifecycle(row);
    requireCheckoutLifecycleCardinality(row, stored);
    return stored.lifecycle === "provisional" ? null : this.#rememberCheckout(stored.checkout);
  }

  listCheckouts(repoId: number): readonly CheckoutRow[] {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    return this.#listCheckoutsOwned(repoId);
  }

  #listCheckoutsOwned(repoId: number): readonly CheckoutRow[] {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    const rows: CheckoutRow[] = [];
    let primaryCount = 0;
    for (const raw of this.#db.iterate(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
           FROM git_checkouts WHERE repo_id = ?
           ORDER BY root COLLATE BINARY LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
      repoId,
    )) {
      const row = requireStoredCheckoutRow(raw);
      if (row.repoId !== repoId) {
        throw new CorruptError("checkout listing crossed repository boundaries");
      }
      rows.push(this.#rememberCheckout(row));
      if (row.isPrimary) primaryCount++;
      if (rows.length > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "checkout listing exceeds its retained bound");
      }
    }
    if (rows.length > 0 && primaryCount !== 1) {
      throw new CorruptError("repository must have exactly one primary checkout");
    }
    return Object.freeze(rows);
  }

  listRoutingCheckouts(): CheckoutRow[] {
    const rows: CheckoutRow[] = [];
    const primaryCounts = new Map<number, number>();
    const checkoutCounts = new Map<number, number>();
    let policyRetainedBytes = 0;
    let routingCount = 0;
    for (const raw of this.#db.iterate(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head,
              checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_checkouts checkout
         JOIN git_repositories repository ON repository.id = checkout.repo_id
        ORDER BY checkout.root COLLATE BINARY LIMIT ${MAX_ROUTING_CHECKOUTS + 1}`,
    )) {
      const stored = requireStoredCheckoutLifecycle(raw);
      requireCheckoutLifecycleCardinality(raw, stored);
      const row = stored.checkout;
      routingCount++;
      policyRetainedBytes +=
        CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES +
        utf8ByteLength(row.root) +
        utf8ByteLength(row.head);
      if (policyRetainedBytes > MAX_ROUTING_CHECKOUTS_RETAINED_BYTES) {
        throw new GitError("E2BIG", "checkout routing exceeds its 16 MiB retained bound");
      }
      if (stored.lifecycle === "ready") rows.push(this.#rememberCheckout(row));
      const primaryCount = (primaryCounts.get(row.repoId) ?? 0) + (row.isPrimary ? 1 : 0);
      const checkoutCount = (checkoutCounts.get(row.repoId) ?? 0) + 1;
      if (checkoutCount > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "repository checkout routing exceeds its retained bound");
      }
      primaryCounts.set(row.repoId, primaryCount);
      checkoutCounts.set(row.repoId, checkoutCount);
      if (routingCount > MAX_ROUTING_CHECKOUTS) {
        throw new GitError("E2BIG", "checkout routing exceeds its retained bound");
      }
    }
    for (const count of primaryCounts.values()) {
      if (count !== 1) throw new CorruptError("repository must have exactly one primary checkout");
    }
    return rows;
  }

  /** All routing roots, including provisional roots that block parent traversal. */
  listRoutingRoots(): string[] {
    const roots: string[] = [];
    const primaryCounts = new Map<number, number>();
    const checkoutCounts = new Map<number, number>();
    let policyRetainedBytes = 0;
    let rootUtf8Bytes = 0;
    for (const raw of this.#db.iterate(
      `SELECT checkout.id AS checkout_id, checkout.repo_id, checkout.root,
              checkout.head,
              checkout.is_primary, repository.lifecycle,
              repository.clone_generation, repository.clone_expires_ms,
              ${CHECKOUT_LIFECYCLE_CARDINALITY_SQL}
         FROM git_checkouts checkout
         JOIN git_repositories repository ON repository.id = checkout.repo_id
        ORDER BY checkout.root COLLATE BINARY LIMIT ${MAX_ROUTING_CHECKOUTS + 1}`,
    )) {
      const stored = requireStoredCheckoutLifecycle(raw);
      requireCheckoutLifecycleCardinality(raw, stored);
      const row = stored.checkout;
      const primaryCount = (primaryCounts.get(row.repoId) ?? 0) + (row.isPrimary ? 1 : 0);
      const checkoutCount = (checkoutCounts.get(row.repoId) ?? 0) + 1;
      if (checkoutCount > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "repository checkout routing exceeds its retained bound");
      }
      const rowRootBytes = utf8ByteLength(row.root);
      rootUtf8Bytes += rowRootBytes;
      if (rootUtf8Bytes > MAX_ROUTING_ROOTS_UTF8_BYTES) {
        throw new GitError("E2BIG", "checkout routing roots exceed their 6 MiB UTF-8 bound");
      }
      policyRetainedBytes +=
        CHECKOUT_LIST_ROW_FIXED_RETAINED_BYTES + rowRootBytes + utf8ByteLength(row.head);
      if (policyRetainedBytes > MAX_ROUTING_CHECKOUTS_RETAINED_BYTES) {
        throw new GitError("E2BIG", "checkout routing exceeds its 16 MiB retained bound");
      }
      primaryCounts.set(row.repoId, primaryCount);
      checkoutCounts.set(row.repoId, checkoutCount);
      roots.push(row.root);
      if (roots.length > MAX_ROUTING_CHECKOUTS) {
        throw new GitError("E2BIG", "checkout routing exceeds its retained bound");
      }
    }
    for (const count of primaryCounts.values()) {
      if (count !== 1) throw new CorruptError("repository must have exactly one primary checkout");
    }
    return roots;
  }

  beginProvisionalClone(
    root: string,
    head: string,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): ProvisionalCloneOwner {
    const normalized = this.#checkoutRootInput(root);
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
      created = this.#db.transactionSync(() => {
        const existing = this.#repositoryAtRoot(normalized);
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
          const oldStore = this.#provisionalStore(existing.checkout, oldGeneration).store;
          const result = cleanup(oldStore);
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "provisional clone cleanup must be synchronous");
          }
          const deleted = this.#db.one<Record<string, unknown>>(
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

        const identity = this.#allocateIdentities(true, true, true);
        this.#db.run(
          `INSERT INTO git_repositories
             (id, lifecycle, clone_generation, clone_expires_ms)
           VALUES (?, 'provisional', ?, ?)`,
          identity.repoId,
          identity.cloneGeneration,
          expiresMs,
        );
        this.#db.run(
          `INSERT INTO git_pack_ingest_control
             (repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms)
           VALUES (?, 0, 0, NULL, NULL)`,
          identity.repoId,
        );
        this.#db.run(
          `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
           VALUES (?, ?, ?, ?, 1)`,
          identity.checkoutId,
          identity.repoId,
          normalized,
          checkedHead,
        );
        advanceCheckoutRevision(this.#db, identity.repoId);
        this.#db.run(
          "INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (?, 0)",
          identity.repoId,
        );
        this.#db.run(
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
        this.#evictProvisional(cleanupGeneration);
      }
      throw error;
    }

    if (created.evictedGeneration !== null) {
      this.#evictProvisional(created.evictedGeneration);
    }
    const checkout = Object.freeze(created.checkout);
    const record = this.#provisionalStore(checkout, created.generation);
    const owner = Object.freeze({
      checkout,
      generation: created.generation,
      store: record.store,
    });
    this.#issuedProvisionalOwners.add(owner);
    return owner;
  }

  renewProvisionalClone(owner: ProvisionalCloneOwner, now: number): number {
    const nowMs = requireMilliseconds(now, "clone lease clock", "input");
    try {
      return this.#db.transactionSync(() => {
        const stored = this.#requireProvisionalOwner(owner, nowMs);
        const currentExpiry = stored.cloneExpiresMs;
        if (currentExpiry === null) throw new CorruptError("provisional clone lease is missing");
        if (currentExpiry - nowMs > PROVISIONAL_CLONE_RENEW_WINDOW_MS) return currentExpiry;
        const nextExpiry = provisionalCloneExpiry(nowMs);
        const updated = this.#db.one<Record<string, unknown>>(
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
      if (hasErrorCode(error, "ESTALE")) this.#evictProvisionalOwner(owner);
      throw error;
    }
  }

  publishProvisionalClone(
    owner: ProvisionalCloneOwner,
    now: number,
    prepare?: (store: CheckoutStore) => undefined,
  ): CheckoutRow {
    const nowMs = requireMilliseconds(now, "clone lease clock", "input");
    let prepareStarted = false;
    let synchronousPrepareFailure = false;
    try {
      const published = this.#db.transactionSync(() => {
        const stored = this.#requireProvisionalOwner(owner, nowMs);
        const expiry = stored.cloneExpiresMs;
        if (expiry === null) throw new CorruptError("provisional clone lease is missing");
        if (prepare !== undefined) {
          prepareStarted = true;
          let result: undefined;
          try {
            result = prepare(owner.store);
          } catch (error) {
            synchronousPrepareFailure = true;
            throw error;
          }
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "provisional clone preparation must be synchronous");
          }
        }
        const updated = this.#db.one<Record<string, unknown>>(
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
      this.#evictProvisionalOwner(owner);
      this.#issuedProvisionalOwners.delete(owner);
      return this.#rememberCheckout(published, true);
    } catch (error) {
      const record = this.#provisionalRecordForOwner(owner);
      if (synchronousPrepareFailure && record !== null) {
        // The rollback preserves this exact owner for the bounded native-to-fallback retry.
        record.shared.revalidateStorageCaches();
      } else if (prepareStarted || hasErrorCode(error, "ESTALE")) {
        this.#evictProvisionalOwner(owner);
      }
      throw error;
    }
  }

  discardProvisionalClone(
    owner: ProvisionalCloneOwner,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): void {
    requireMilliseconds(now, "clone lease clock", "input");
    let cleanupRecord: ProvisionalStoreRecord | null = null;
    try {
      this.#db.transactionSync(() => {
        const stored = this.#storedProvisionalOwner(owner);
        const generation = owner.generation;
        const existing = this.#provisionalStores.get(generation);
        if (existing !== undefined && existing.store !== owner.store) {
          throw new GitError("ESTALE", "provisional clone facade belongs to another owner");
        }
        cleanupRecord = existing ?? this.#provisionalStore(stored.checkout, generation);
        const result = cleanup(cleanupRecord.store);
        if (isThenableResult(result)) {
          void Promise.resolve(result).catch(() => {});
          throw new GitError("EINVAL", "provisional clone cleanup must be synchronous");
        }
        const deleted = this.#db.one<Record<string, unknown>>(
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
      if (cleanupRecord !== null) this.#evictProvisionalRecord(cleanupRecord);
      else if (hasErrorCode(error, "ESTALE")) this.#evictProvisionalOwner(owner);
      throw error;
    }
    if (cleanupRecord === null) {
      throw new CorruptError("provisional clone cleanup facade was not created");
    }
    this.#evictProvisionalRecord(cleanupRecord);
    this.#issuedProvisionalOwners.delete(owner);
  }

  createRepository(root: string, head: string): CheckoutRow {
    const normalized = this.#checkoutRootInput(root);
    const checkedHead = requireRawRefTarget(head, "initial HEAD target", "input");
    return this.#db.transactionSync(() => {
      const existing = this.#repositoryAtRoot(normalized);
      if (existing !== null) {
        if (existing.lifecycle === "provisional") {
          throw new GitError("EBUSY", `clone at ${normalized} is still in progress`);
        }
        throw new GitError("EALREADYINIT", `repository already exists at ${normalized}`);
      }
      const identity = this.#allocateIdentities(true, true, false);
      const repoId = identity.repoId;
      const checkoutId = identity.checkoutId;
      try {
        this.#db.run("INSERT INTO git_repositories (id) VALUES (?)", repoId);
      } catch (error) {
        throw new CorruptError("repository identity control precedes stored repositories", {
          cause: error,
        });
      }
      this.#db.run(
        `INSERT INTO git_pack_ingest_control
           (repo_id, owner_generation, last_pack_id, active_pack_id, expires_ms)
         VALUES (?, 0, 0, NULL, NULL)`,
        repoId,
      );
      this.#db.run(
        `INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
         VALUES (?, ?, ?, ?, 1)`,
        checkoutId,
        repoId,
        normalized,
        checkedHead,
      );
      advanceCheckoutRevision(this.#db, repoId);
      this.#db.run("INSERT INTO git_reflog_state (repo_id, next_ordinal) VALUES (?, 0)", repoId);
      this.#db.run(
        `INSERT OR IGNORE INTO git_index_state
           (checkout_id, baseline_tree_oid, format, complete) VALUES (?, NULL, 1, 0)`,
        checkoutId,
      );
      return this.#rememberCheckout(
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
  createCheckout(
    repoId: number,
    root: string,
    head: string,
    initialize?: (store: CheckoutStore) => undefined,
  ): CheckoutRow {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    const normalized = this.#checkoutRootInput(root);
    const checkedHead = requireRawRefTarget(head, "initial HEAD target", "input");
    const attached = rawSymbolicTarget(checkedHead);
    const shared = this.openShared(repoId);

    const lifetime = new CheckoutStoreLifetime();
    let created: {
      row: CheckoutRow;
      store: CheckoutStore;
      lifetime: CheckoutStoreLifetime;
    };
    try {
      created = this.#db.transactionSync(() => {
        const count = this.#db.scalar<unknown>(
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

        const rootOwner = this.#db.one<Record<string, unknown>>(
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
          const branchOwner = this.#db.one<Record<string, unknown>>(
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

        const checkoutId = this.#allocateIdentities(false, true, false).checkoutId;
        try {
          this.#db.run(
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
        advanceCheckoutRevision(this.#db, repoId);
        this.#db.run(
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
          this.#options,
          () => this.destroyRepository(repoId),
          lifetime,
        );
        if (initialize !== undefined) {
          const result = initialize(store);
          if (isThenableResult(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new GitError("EINVAL", "checkout initialization must be synchronous");
          }
        }
        bumpMaintenanceRootEpoch(this.#db, repoId);
        return { row: { ...initial, head: store.head() }, store, lifetime };
      });
    } catch (error) {
      lifetime.revoke();
      shared.revalidateStorageCaches();
      throw error;
    }

    const remembered = this.#rememberCheckout(created.row, true);
    this.#checkoutStores.set(remembered.id, created.store);
    this.#checkoutLifetimes.set(remembered.id, created.lifetime);
    return remembered;
  }

  /** Remove one non-primary checkout after the caller deletes its root. */
  removeCheckout(
    checkoutId: number,
    removeRoot: (checkout: CheckoutRow) => undefined,
  ): CheckoutRow {
    if (!Number.isSafeInteger(checkoutId) || checkoutId < 1) {
      throw new GitError("EINVAL", "checkout id must be a safe positive integer");
    }
    const removed = this.#db.transactionSync(() => {
      const raw = this.#db.one<Record<string, unknown>>(
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
      this.#requireCheckoutsIdle(row.repoId, [row.id]);
      advanceCheckoutRevision(this.#db, row.repoId);
      const result = removeRoot(Object.freeze(row));
      if (isThenableResult(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new GitError("EINVAL", "checkout removal must be synchronous");
      }
      const deleted = this.#db.one<Record<string, unknown>>(
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
      bumpMaintenanceRootEpoch(this.#db, row.repoId);
      return Object.freeze(row);
    });
    this.#evictCheckout(removed.id);
    return removed;
  }

  /** Remove a bounded set of non-primary checkouts in one atomic delete. */
  removeCheckouts(repoId: number, checkoutIds: readonly number[]): readonly CheckoutRow[] {
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
    this.openShared(repoId);
    const idsJson = JSON.stringify(uniqueIds);
    const removed = this.#db.transactionSync(() => {
      const rows: CheckoutRow[] = [];
      const selectedIds = new Set<number>();
      for (const raw of this.#db.iterate(
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
      this.#requireCheckoutsIdle(repoId, existingIds);
      const existingJson = JSON.stringify(existingIds);
      const deleted = this.#db.all<Record<string, unknown>>(
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
      advanceCheckoutRevision(this.#db, repoId, rows.length);
      bumpMaintenanceRootEpoch(this.#db, repoId);
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    });
    for (const row of removed) this.#evictCheckout(row.id);
    return removed;
  }

  openShared(repoId: number): SharedRepoStore {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    this.#requireReadyRepository(repoId);
    const existing = this.#sharedStores.get(repoId);
    if (existing !== undefined) return existing;
    const row = this.#db.one<Record<string, unknown>>(
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
    if (!Number.isSafeInteger(this.#nextStoreGeneration)) {
      throw new GitError("E2BIG", "repository store generation is exhausted");
    }
    const generation = this.#nextStoreGeneration++;
    const store = new SharedRepoStore(
      this.#db,
      repoId,
      generation,
      this.#objects,
      this.#packRows,
      this.#options.now ?? Date.now,
      this.#options,
    );
    this.#sharedStores.set(repoId, store);
    const primaryRaw = this.#db.one<Record<string, unknown>>(
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
      this.#options,
      () => this.destroyRepository(repoId),
      lifetime,
    );
    this.#checkoutStores.set(primary.id, primaryStore);
    this.#checkoutLifetimes.set(primary.id, lifetime);
    return store;
  }

  openCheckout(checkout: CheckoutRow | number): CheckoutStore {
    const checkoutId =
      typeof checkout === "number" ? checkout : requireSafeId(checkout.id, "checkout id");
    if (typeof checkout !== "number") this.#rejectStaleCheckoutRow(checkout, checkoutId);
    const durable = this.#checkoutById(checkoutId);
    if (
      typeof checkout !== "number" &&
      (checkout.repoId !== durable.repoId ||
        checkout.root !== durable.root ||
        checkout.isPrimary !== durable.isPrimary)
    ) {
      throw new CorruptError("checkout identity changed before it was opened");
    }
    const existing = this.#checkoutStores.get(checkoutId);
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
    const installed = this.#checkoutStores.get(checkoutId);
    if (installed !== undefined) return installed;
    const lifetime = new CheckoutStoreLifetime();
    const store = new CheckoutStore(
      shared,
      stored,
      this.#options,
      () => this.destroyRepository(stored.repoId),
      lifetime,
    );
    this.#checkoutStores.set(checkoutId, store);
    this.#checkoutLifetimes.set(checkoutId, lifetime);
    return store;
  }

  #checkoutById(checkoutId: number): CheckoutRow {
    const raw = this.#db.one<Record<string, unknown>>(
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

  #rejectStaleCheckoutRow(checkout: CheckoutRow, checkoutId: number): void {
    const rememberedGeneration = this.#validatedCheckoutRows.get(checkout);
    if (
      rememberedGeneration !== undefined &&
      rememberedGeneration !== this.#checkoutRowGenerations.get(checkoutId)
    ) {
      throw new GitError("EWORKTREENOTFOUND", "checkout identity is no longer active");
    }
  }

  #rememberCheckout(row: CheckoutRow, replaceIdentity = false): CheckoutRow {
    let generation = replaceIdentity ? undefined : this.#checkoutRowGenerations.get(row.id);
    if (generation === undefined) {
      if (!Number.isSafeInteger(this.#nextCheckoutRowGeneration)) {
        throw new GitError("E2BIG", "checkout row generation is exhausted");
      }
      generation = this.#nextCheckoutRowGeneration++;
      this.#checkoutRowGenerations.set(row.id, generation);
    }
    const remembered = Object.freeze(row);
    this.#validatedCheckoutRows.set(remembered, generation);
    return remembered;
  }

  #requireCheckoutsIdle(repoId: number, checkoutIds: readonly number[]): void {
    if (checkoutIds.length === 0) return;
    const row = this.#db.one<Record<string, unknown>>(
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

  #evictCheckout(checkoutId: number): void {
    this.#checkoutLifetimes.get(checkoutId)?.revoke();
    this.#checkoutLifetimes.delete(checkoutId);
    this.#checkoutStores.delete(checkoutId);
    this.#checkoutRowGenerations.delete(checkoutId);
  }

  /** Advance one internal maintenance root page after validating every live journal. */
  advanceMaintenanceRootSnapshot(
    repoId: number,
    options: MaintenanceRootAdvanceOptions,
  ): MaintenanceRootSnapshotProgress {
    return this.#advanceMaintenanceRootSnapshot(repoId, options);
  }

  #advanceMaintenanceRootSnapshot(
    repoId: number,
    options: MaintenanceRootAdvanceOptions,
  ): MaintenanceRootSnapshotProgress {
    this.openShared(repoId);
    const rootOptions = {
      repoId,
      nowMs: options.nowMs,
      readOperationRoots: (checkoutId: number) => {
        const checkout = this.#checkoutById(checkoutId);
        if (checkout.repoId !== repoId) {
          throw new CorruptError("maintenance operation root crossed repositories");
        }
        const journal = readOperationStateOwned(this.openCheckout(checkout));
        return journal === null ? [] : validatedOperationJournalRoots(journal);
      },
    };
    if (options.pageRows === undefined) return advanceRootSnapshot(this.#db, rootOptions);
    return advanceRootSnapshot(this.#db, { ...rootOptions, pageRows: options.pageRows });
  }

  destroyRepository(repoId: number): void {
    if (!Number.isSafeInteger(repoId) || repoId < 1) {
      throw new GitError("EINVAL", "repository id must be a safe positive integer");
    }
    this.#requireReadyRepository(repoId);
    this.#db.run("DELETE FROM git_repositories WHERE id = ? AND lifecycle = 'ready'", repoId);
    const shared = this.#sharedStores.get(repoId);
    shared?.clearCaches();
    this.#sharedStores.delete(repoId);
    for (const [checkoutId, store] of this.#checkoutStores) {
      if (store.sharedRepoId === repoId) this.#evictCheckout(checkoutId);
    }
  }
}

/** @internal Advance maintenance through the database-owned seam. */
export function advanceMaintenanceRootSnapshotOwned(
  database: SqliteGitDatabase,
  repoId: number,
  options: MaintenanceRootAdvanceOptions,
): MaintenanceRootSnapshotProgress {
  const advance = OWNED_MAINTENANCE_ROOT_ADVANCERS.get(database);
  if (advance === undefined) {
    throw new GitError("EINVAL", "maintenance database owner is unavailable");
  }
  return advance(repoId, options);
}

/** @internal List checkouts through the database-owned seam. */
export function listCheckoutsOwned(
  database: SqliteGitDatabase,
  repoId: number,
): readonly CheckoutRow[] {
  const list = OWNED_CHECKOUT_LISTERS.get(database);
  if (list === undefined) {
    throw new GitError("EINVAL", "checkout database owner is unavailable");
  }
  return list(repoId);
}
