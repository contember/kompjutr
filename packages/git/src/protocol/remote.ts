// Smart HTTP, client side, protocol v0.
//
// v0 is what every server still speaks, and a single round trip that ends
// in `done` is enough for both clone and incremental fetch: the server
// computes the common set from the haves it was given. Nothing here needs
// multi-ack.

export { type Advertisement, discover, type RemoteRef } from "./discovery.js";
export {
  AGENT,
  baseHeaders,
  drain,
  MAX_PROTOCOL_NEGOTIATION_ENTRIES,
  normalizeRemoteUrl,
  type ProtocolMemoryLimits,
  type ProtocolRequestOptions,
  type Service,
} from "./remote-base.js";
export {
  type UploadPackFilter,
  uploadPack,
} from "./upload-pack.js";
