// The repository registry and the per-repository store: objects, refs,
// config and the index, all as rows.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../common/errors.js";
import type { CheckoutStore } from "../checkout/checkout.js";
import type { CheckoutRow, ProvisionalCloneOwner, StoreOptions } from "../core/contracts.js";
import { withGitMutationGuard } from "../core/mutation-guard.js";
import {
  advanceMaintenanceRootSnapshot as advanceRootSnapshot,
  type MaintenanceRootSnapshotProgress,
} from "../maintenance/roots.js";
import type { SharedRepoStore } from "../repository/shared.js";
import { initializeGitSchema } from "../schema/schema.js";
import { DatabaseCheckoutMutations } from "./database-checkout-mutations.js";
import { DatabaseIdentities } from "./database-identities.js";
import { DatabaseProvisionalClones } from "./database-provisional.js";
import { DatabaseRegistry } from "./database-registry.js";
import { DatabaseRouting } from "./database-routing.js";
import { createDatabaseState, type DatabaseState } from "./database-state.js";
import { enforceForeignKeys } from "./lifecycle.js";

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
type OwnedMutationGuard = <T>(body: () => T) => T;
const OWNED_MUTATION_GUARDS = new WeakMap<object, OwnedMutationGuard>();
interface SqliteGitDatabaseMutations {
  beginProvisionalCloneOwned(
    root: string,
    head: string,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): ProvisionalCloneOwner;
  renewProvisionalCloneOwned(owner: ProvisionalCloneOwner, now: number): number;
  publishProvisionalCloneOwned(
    owner: ProvisionalCloneOwner,
    now: number,
    prepare?: (store: CheckoutStore) => undefined,
  ): CheckoutRow;
  discardProvisionalCloneOwned(
    owner: ProvisionalCloneOwner,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): void;
  createRepositoryOwned(root: string, head: string): CheckoutRow;
  createCheckoutOwned(
    repoId: number,
    root: string,
    head: string,
    initialize?: (store: CheckoutStore) => undefined,
  ): CheckoutRow;
  removeCheckoutOwned(
    checkoutId: number,
    removeRoot: (checkout: CheckoutRow) => undefined,
  ): CheckoutRow;
  removeCheckoutsOwned(repoId: number, checkoutIds: readonly number[]): readonly CheckoutRow[];
  destroyRepositoryOwned(repoId: number): void;
}

const SQLITE_GIT_DATABASE_MUTATIONS = new WeakMap<object, SqliteGitDatabaseMutations>();

/** Internal mutation capability; intentionally absent from the package facade. */
export function sqliteGitDatabaseMutations(
  database: SqliteGitDatabase,
): SqliteGitDatabaseMutations {
  const mutations = SQLITE_GIT_DATABASE_MUTATIONS.get(database);
  if (mutations === undefined)
    throw new CorruptError("Git database mutation capability is missing");
  return mutations;
}

/** Owns the schema plus shared-store and checkout facade registries. */
export class SqliteGitDatabase {
  readonly #state: DatabaseState;
  readonly #identities: DatabaseIdentities;
  readonly #registry: DatabaseRegistry;
  readonly #routing: DatabaseRouting;
  readonly #provisional: DatabaseProvisionalClones;
  readonly #checkouts: DatabaseCheckoutMutations;

  constructor(db: SqlDatabase, options: StoreOptions = {}) {
    this.#state = createDatabaseState(db, options);
    enforceForeignKeys(db);
    initializeGitSchema(db);
    this.#identities = new DatabaseIdentities(this.#state);
    this.#identities.readIdentityControl();
    this.#registry = new DatabaseRegistry(this.#state, this.#identities, (repoId) =>
      this.destroyRepositoryOwned(repoId),
    );
    this.#routing = new DatabaseRouting(this.#state, this.#registry);
    this.#checkouts = new DatabaseCheckoutMutations(this.#state, this.#identities, this.#registry);
    this.#provisional = new DatabaseProvisionalClones(
      this.#state,
      this.#identities,
      this.#registry,
    );
    OWNED_MAINTENANCE_ROOT_ADVANCERS.set(this, (repoId, rootOptions) =>
      this.#advanceMaintenanceRootSnapshot(repoId, rootOptions),
    );
    OWNED_CHECKOUT_LISTERS.set(this, (repoId) => this.#routing.listCheckoutsOwned(repoId));
    OWNED_MUTATION_GUARDS.set(this, (body) => withGitMutationGuard(this.#state.db, body));
    SQLITE_GIT_DATABASE_MUTATIONS.set(this, {
      beginProvisionalCloneOwned: (root, head, now, cleanup) =>
        this.beginProvisionalCloneOwned(root, head, now, cleanup),
      renewProvisionalCloneOwned: (owner, now) => this.renewProvisionalCloneOwned(owner, now),
      publishProvisionalCloneOwned: (owner, now, prepare) =>
        this.publishProvisionalCloneOwned(owner, now, prepare),
      discardProvisionalCloneOwned: (owner, now, cleanup) =>
        this.discardProvisionalCloneOwned(owner, now, cleanup),
      createRepositoryOwned: (root, head) => this.createRepositoryOwned(root, head),
      createCheckoutOwned: (repoId, root, head, initialize) =>
        this.createCheckoutOwned(repoId, root, head, initialize),
      removeCheckoutOwned: (checkoutId, removeRoot) =>
        this.removeCheckoutOwned(checkoutId, removeRoot),
      removeCheckoutsOwned: (repoId, checkoutIds) => this.removeCheckoutsOwned(repoId, checkoutIds),
      destroyRepositoryOwned: (repoId) => this.destroyRepositoryOwned(repoId),
    });
  }

  get db(): SqlDatabase {
    return this.#state.db;
  }

  /** The checkout whose root is the nearest registered ancestor of `dir`. */
  findCheckout(dir: string): CheckoutRow | null {
    return this.#routing.findCheckout(dir);
  }

  checkoutAt(root: string): CheckoutRow | null {
    return this.#routing.checkoutAt(root);
  }

  listCheckouts(repoId: number): readonly CheckoutRow[] {
    return this.#routing.listCheckouts(repoId);
  }

  listRoutingCheckouts(): CheckoutRow[] {
    return this.#routing.listRoutingCheckouts();
  }

  /** All routing roots, including provisional roots that block parent traversal. */
  listRoutingRoots(): string[] {
    return this.#routing.listRoutingRoots();
  }

  beginProvisionalClone(
    root: string,
    head: string,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): ProvisionalCloneOwner {
    return withGitMutationGuard(this.#state.db, () =>
      this.beginProvisionalCloneOwned(root, head, now, cleanup),
    );
  }

  /** @internal Begin a provisional clone while the caller owns the mutation guard. */
  private beginProvisionalCloneOwned(
    root: string,
    head: string,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): ProvisionalCloneOwner {
    return this.#provisional.beginProvisionalCloneOwned(root, head, now, cleanup);
  }

  renewProvisionalClone(owner: ProvisionalCloneOwner, now: number): number {
    return withGitMutationGuard(this.#state.db, () => this.renewProvisionalCloneOwned(owner, now));
  }

  /** @internal Renew a provisional clone while the caller owns the mutation guard. */
  private renewProvisionalCloneOwned(owner: ProvisionalCloneOwner, now: number): number {
    return this.#provisional.renewProvisionalCloneOwned(owner, now);
  }

  publishProvisionalClone(
    owner: ProvisionalCloneOwner,
    now: number,
    prepare?: (store: CheckoutStore) => undefined,
  ): CheckoutRow {
    return withGitMutationGuard(this.#state.db, () =>
      this.publishProvisionalCloneOwned(owner, now, prepare),
    );
  }

  /** @internal Publish a provisional clone while the caller owns the mutation guard. */
  private publishProvisionalCloneOwned(
    owner: ProvisionalCloneOwner,
    now: number,
    prepare?: (store: CheckoutStore) => undefined,
  ): CheckoutRow {
    return this.#provisional.publishProvisionalCloneOwned(owner, now, prepare);
  }

  discardProvisionalClone(
    owner: ProvisionalCloneOwner,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): void {
    withGitMutationGuard(this.#state.db, () =>
      this.discardProvisionalCloneOwned(owner, now, cleanup),
    );
  }

  /** @internal Discard a provisional clone while the caller owns the mutation guard. */
  private discardProvisionalCloneOwned(
    owner: ProvisionalCloneOwner,
    now: number,
    cleanup: (store: CheckoutStore) => undefined,
  ): void {
    this.#provisional.discardProvisionalCloneOwned(owner, now, cleanup);
  }

  createRepository(root: string, head: string): CheckoutRow {
    return withGitMutationGuard(this.#state.db, () => this.createRepositoryOwned(root, head));
  }

  /** @internal Create a repository while the caller owns the mutation guard. */
  private createRepositoryOwned(root: string, head: string): CheckoutRow {
    return this.#checkouts.createRepositoryOwned(root, head);
  }

  createCheckout(
    repoId: number,
    root: string,
    head: string,
    initialize?: (store: CheckoutStore) => undefined,
  ): CheckoutRow {
    return withGitMutationGuard(this.#state.db, () =>
      this.createCheckoutOwned(repoId, root, head, initialize),
    );
  }

  /** @internal Create a checkout while the caller owns the mutation guard. */
  private createCheckoutOwned(
    repoId: number,
    root: string,
    head: string,
    initialize?: (store: CheckoutStore) => undefined,
  ): CheckoutRow {
    return this.#checkouts.createCheckoutOwned(repoId, root, head, initialize);
  }

  removeCheckout(
    checkoutId: number,
    removeRoot: (checkout: CheckoutRow) => undefined,
  ): CheckoutRow {
    return withGitMutationGuard(this.#state.db, () =>
      this.removeCheckoutOwned(checkoutId, removeRoot),
    );
  }

  /** @internal Remove a checkout while the caller owns the mutation guard. */
  private removeCheckoutOwned(
    checkoutId: number,
    removeRoot: (checkout: CheckoutRow) => undefined,
  ): CheckoutRow {
    return this.#checkouts.removeCheckoutOwned(checkoutId, removeRoot);
  }

  removeCheckouts(repoId: number, checkoutIds: readonly number[]): readonly CheckoutRow[] {
    return withGitMutationGuard(this.#state.db, () =>
      this.removeCheckoutsOwned(repoId, checkoutIds),
    );
  }

  /** @internal Remove checkouts while the caller owns the mutation guard. */
  private removeCheckoutsOwned(
    repoId: number,
    checkoutIds: readonly number[],
  ): readonly CheckoutRow[] {
    return this.#checkouts.removeCheckoutsOwned(repoId, checkoutIds);
  }

  openShared(repoId: number): SharedRepoStore {
    return this.#registry.openShared(repoId);
  }

  openCheckout(checkout: CheckoutRow | number): CheckoutStore {
    return this.#registry.openCheckout(checkout);
  }

  /** Advance one internal maintenance root page through bounded source projections. */
  advanceMaintenanceRootSnapshot(
    repoId: number,
    options: MaintenanceRootAdvanceOptions,
  ): MaintenanceRootSnapshotProgress {
    return withGitMutationGuard(this.#state.db, () =>
      this.#advanceMaintenanceRootSnapshot(repoId, options),
    );
  }

  #advanceMaintenanceRootSnapshot(
    repoId: number,
    options: MaintenanceRootAdvanceOptions,
  ): MaintenanceRootSnapshotProgress {
    this.openShared(repoId);
    const rootOptions = {
      repoId,
      nowMs: options.nowMs,
      readOperationRootPage: (checkoutId: number, cursor: number, limit: number) => {
        const checkout = this.openCheckout(checkoutId);
        if (checkout.sharedRepoId !== repoId) {
          throw new CorruptError("maintenance operation root crossed repositories");
        }
        return checkout.operationRootPage(cursor, limit);
      },
    };
    if (options.pageRows === undefined) return advanceRootSnapshot(this.#state.db, rootOptions);
    return advanceRootSnapshot(this.#state.db, { ...rootOptions, pageRows: options.pageRows });
  }

  destroyRepository(repoId: number): void {
    withGitMutationGuard(this.#state.db, () => this.destroyRepositoryOwned(repoId));
  }

  /** @internal Destroy a repository while the caller owns the mutation guard. */
  private destroyRepositoryOwned(repoId: number): void {
    this.#checkouts.destroyRepositoryOwned(repoId);
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

/** @internal Run one synchronous public Git mutation under the database-local guard. */
export function withGitMutationGuardOwned<T>(database: SqliteGitDatabase, body: () => T): T {
  const guard = OWNED_MUTATION_GUARDS.get(database);
  if (guard === undefined) {
    throw new GitError("EINVAL", "Git mutation database owner is unavailable");
  }
  return guard(body);
}
