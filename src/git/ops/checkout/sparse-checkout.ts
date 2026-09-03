// Stable facade for sparse checkout selection, validation, and application.

export {
  checkoutSparseChanges,
  type SparseCheckoutChange,
} from "./sparse-checkout-apply.js";
export { trySparseCleanCheckout } from "./sparse-checkout-operation.js";
