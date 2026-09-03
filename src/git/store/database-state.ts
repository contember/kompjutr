import type { SqlDatabase } from "../../db/db.js";
import { ByteLru } from "../common/lru.js";
import type { RawObject } from "../common/objects.js";
import { type CheckoutStore, DEFAULT_OBJECT_CACHE_BYTES } from "./checkout.js";
import type { CheckoutRow, ProvisionalCloneOwner, StoreOptions } from "./contracts.js";
import type { CheckoutStoreLifetime } from "./lifecycle.js";
import { requireCheckoutRoot, requireCheckoutRootInput } from "./lifecycle.js";
import { MAX_PACK_ROW_CACHE_BYTES } from "./packs.js";
import type { SharedRepoStore } from "./shared.js";

const LIFECYCLE_MUTATION_CHECKOUTS = new WeakSet<object>();

export function isLifecycleMutationCheckout(store: CheckoutStore): boolean {
  return LIFECYCLE_MUTATION_CHECKOUTS.has(store);
}

export function withLifecycleCheckoutMutations<T>(store: CheckoutStore, body: () => T): T {
  const alreadyAuthorized = LIFECYCLE_MUTATION_CHECKOUTS.has(store);
  if (!alreadyAuthorized) LIFECYCLE_MUTATION_CHECKOUTS.add(store);
  try {
    return body();
  } finally {
    if (!alreadyAuthorized) LIFECYCLE_MUTATION_CHECKOUTS.delete(store);
  }
}

export interface ProvisionalStoreRecord {
  generation: number;
  repoId: number;
  checkoutId: number;
  shared: SharedRepoStore;
  store: CheckoutStore;
  lifetime: CheckoutStoreLifetime;
}

export interface DatabaseState {
  readonly db: SqlDatabase;
  readonly options: StoreOptions;
  readonly sharedStores: Map<number, SharedRepoStore>;
  readonly checkoutStores: Map<number, CheckoutStore>;
  readonly checkoutLifetimes: Map<number, CheckoutStoreLifetime>;
  readonly validatedCheckoutRows: WeakMap<CheckoutRow, number>;
  readonly checkoutRowGenerations: Map<number, number>;
  readonly provisionalStores: Map<number, ProvisionalStoreRecord>;
  readonly issuedProvisionalOwners: WeakSet<ProvisionalCloneOwner>;
  readonly objects: ByteLru<string, RawObject>;
  readonly packRows: ByteLru<string, Uint8Array>;
  nextStoreGeneration: number;
  nextCheckoutRowGeneration: number;
}

export function createDatabaseState(db: SqlDatabase, options: StoreOptions): DatabaseState {
  return {
    db,
    options,
    sharedStores: new Map(),
    checkoutStores: new Map(),
    checkoutLifetimes: new Map(),
    validatedCheckoutRows: new WeakMap(),
    checkoutRowGenerations: new Map(),
    provisionalStores: new Map(),
    issuedProvisionalOwners: new WeakSet(),
    objects: new ByteLru(
      Math.min(options.objectCacheBytes ?? DEFAULT_OBJECT_CACHE_BYTES, DEFAULT_OBJECT_CACHE_BYTES),
      (object) => object.data.length,
    ),
    packRows: new ByteLru(
      Math.min(options.chunkBytes ?? MAX_PACK_ROW_CACHE_BYTES, MAX_PACK_ROW_CACHE_BYTES),
      (row) => row.length,
    ),
    nextStoreGeneration: 1,
    nextCheckoutRowGeneration: 1,
  };
}

export function checkoutRootInput(root: unknown): string {
  const checkedInput = requireCheckoutRootInput(root);
  return requireCheckoutRoot(checkedInput, "input");
}
