import type { SqlDatabase } from "../../db/db.js";
import { CorruptError } from "../common/errors.js";
import type { CheckoutStore } from "./checkout.js";
import { CheckoutIndexStore } from "./checkout-index.js";
import {
  bindCheckoutStoreMutations,
  type CheckoutStoreMutations,
  createCheckoutStoreMutations,
} from "./checkout-mutations.js";
import { CheckoutOperationStore } from "./checkout-operation.js";
import { CheckoutRefStore } from "./checkout-refs.js";
import type { CheckoutRow, StoreOptions } from "./contracts.js";
import { type CheckoutStoreLifetime, requireSafeId } from "./lifecycle.js";
import { withGitMutationGuard } from "./mutation-guard.js";
import type { SharedRepoStore } from "./shared.js";

export const NEVER_AUTHORIZE_LIFECYCLE_MUTATION = (): boolean => false;

export interface CheckoutStoreState {
  readonly shared: SharedRepoStore;
  readonly database: SqlDatabase;
  readonly repoId: number;
  readonly checkoutId: number;
  readonly root: string;
  readonly isPrimary: boolean;
  readonly index: CheckoutIndexStore;
  readonly operations: CheckoutOperationStore;
  readonly refs: CheckoutRefStore;
  readonly mutations: CheckoutStoreMutations;
  activeShared(): SharedRepoStore;
  activeDatabase(): SqlDatabase;
  mutate<T>(body: () => T): T;
}

export interface CheckoutStoreWiring {
  readonly store: CheckoutStore;
  readonly shared: SharedRepoStore;
  readonly checkout: CheckoutRow;
  readonly options: StoreOptions;
  readonly onDestroy: (() => void) | undefined;
  readonly lifetime: CheckoutStoreLifetime;
  readonly isLifecycleMutationAuthorized: (store: CheckoutStore) => boolean;
}

export function createCheckoutStoreState(wiring: CheckoutStoreWiring): CheckoutStoreState {
  const { checkout, shared } = wiring;
  if (
    requireSafeId(checkout.id, "checkout id") < 1 ||
    requireSafeId(checkout.repoId, "checkout repository id") !== shared.repoId
  ) {
    throw new CorruptError("checkout facade identity is invalid");
  }
  const now = wiring.options.now ?? Date.now;
  const database = shared.db;
  const repoId = shared.repoId;
  const checkoutId = checkout.id;
  const root = checkout.root;
  const isPrimary = checkout.isPrimary;
  const requireActive = (): void => wiring.lifetime.requireActive();
  const activeShared = (): SharedRepoStore => {
    requireActive();
    return shared;
  };
  const activeDatabase = (): SqlDatabase => {
    requireActive();
    return database;
  };
  const destroyOwned = (): void => {
    requireActive();
    if (wiring.onDestroy !== undefined) {
      activeDatabase().transactionSync(wiring.onDestroy);
      return;
    }
    activeDatabase().transactionSync(() => {
      activeDatabase().run("DELETE FROM git_repositories WHERE id = ?", repoId);
    });
    activeShared().clearCaches();
  };
  const mutate = <T>(body: () => T): T => {
    requireActive();
    if (wiring.isLifecycleMutationAuthorized(wiring.store)) return body();
    return withGitMutationGuard(activeDatabase(), body);
  };
  const index = new CheckoutIndexStore(database, repoId, checkoutId, requireActive);
  const operations = new CheckoutOperationStore(
    database,
    shared,
    repoId,
    checkoutId,
    requireActive,
  );
  const refs = new CheckoutRefStore({
    database,
    shared,
    repoId,
    checkoutId,
    now,
    requireActive,
  });
  shared.bindCheckoutOperations(
    {
      sharedRepoId: repoId,
      checkoutId,
      isPrimary,
      destroyOwned,
    },
    refs.headOwner,
  );
  const mutations = createCheckoutStoreMutations({
    shared: activeShared,
    refs,
    operations,
    index,
    destroyOwned,
  });
  bindCheckoutStoreMutations(wiring.store, mutations);
  return {
    shared,
    database,
    repoId,
    checkoutId,
    root,
    isPrimary,
    index,
    operations,
    refs,
    mutations,
    activeShared,
    activeDatabase,
    mutate,
  };
}
