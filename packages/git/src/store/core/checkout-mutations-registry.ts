import { CorruptError } from "../../common/errors.js";
import type { CheckoutStore } from "../checkout/checkout.js";
import type { CheckoutStoreMutations } from "../checkout/checkout-mutations.js";

// A leaf so lower table families can reach the capability without importing the
// checkout composition root back into their own module graph.
const CHECKOUT_STORE_MUTATIONS = new WeakMap<object, CheckoutStoreMutations>();

export function bindCheckoutStoreMutations(store: object, mutations: CheckoutStoreMutations): void {
  CHECKOUT_STORE_MUTATIONS.set(store, mutations);
}

/** Internal mutation capability; intentionally absent from the package facade. */
export function checkoutStoreMutations(store: CheckoutStore): CheckoutStoreMutations {
  const mutations = CHECKOUT_STORE_MUTATIONS.get(store);
  if (mutations === undefined) {
    throw new CorruptError("checkout store mutation capability is missing");
  }
  return mutations;
}
