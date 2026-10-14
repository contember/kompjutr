import type { Service } from "../../protocol/remote-base.js";
import { encodeAdvertisement } from "../../protocol/server/index.js";
import type { SharedRepoStore } from "../../store/index.js";
import { serverRefSnapshot } from "../../store/refs/server-refs.js";

export function discoverServer(store: SharedRepoStore, service: Service): Iterable<Uint8Array> {
  return encodeAdvertisement(service, serverRefSnapshot(store));
}
