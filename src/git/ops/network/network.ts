// clone and fetch: ref discovery, bounded negotiation, streaming pack
// ingest, then a transactional ref update.
//
// The ordering is the crash-safety contract. The pack is written and
// verified while it is invisible to reads; only once it is complete do the
// refs move, in one transaction. An interrupted fetch leaves every
// existing ref valid and one reclaimable pending pack.

export { clone } from "./network-clone.js";
export { fetchInto } from "./network-fetch.js";
export {
  createRemoteAuth,
  remoteUrlFor,
  validateAbortableNetworkOptions,
  validateFetchOptions,
  validateRemoteAuthOptions,
} from "./network-options.js";
export {
  hydratePromisedBlobs,
  hydrateTreeBlobs,
  withPromisorHydration,
} from "./network-promisor.js";
export type {
  AbortableNetworkOptions,
  CloneOptions,
  FetchOptions,
  FetchResult,
  RemoteAuthOptions,
} from "./network-types.js";
