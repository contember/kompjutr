import { CorruptError, GitError, hasErrorCode, promisedObjectOids } from "../../common/errors.js";
import { MAX_PROTOCOL_NEGOTIATION_ENTRIES, normalizeRemoteUrl } from "../../protocol/remote.js";
import { throwIfAborted } from "../../protocol/stream.js";
import type { ObjectReadInfo, PromisedBlob } from "../../store/index.js";
import { MAX_BLOB_BATCH_OIDS } from "../../store/objects/objects.js";
import { matchesPaths } from "../checkout/checkout.js";
import type { GitContext } from "../core/context.js";
import type { Repository } from "../repository/repository.js";
import { treeStream } from "../tree/tree-stream.js";
import {
  createRemoteAuth,
  remoteUrlFor,
  validateAbortableNetworkOptions,
  validateRemoteAuthOptions,
} from "./network-options.js";
import { fetchAdvertisement, fetchProgressSink, transferPack } from "./network-transfer.js";
import type { AbortableNetworkOptions, RemoteAuthOptions } from "./network-types.js";

const PROMISOR_LOOKUP_PAGE = 4_096;

export function requirePartialFetchTarget(repo: Repository, remote: string, url: string): void {
  const configured = remoteUrlFor(repo, remote);
  if (configured === undefined || normalizeRemoteUrl(configured) !== normalizeRemoteUrl(url)) {
    throw new GitError(
      "EPROMISORREMOTE",
      `filtered fetch requires configured remote ${remote} at the requested URL`,
    );
  }
  const existing = repo.store.readPromisorRemote(remote);
  if (existing !== null && existing.url !== normalizeRemoteUrl(url)) {
    throw new GitError("EPROMISORREMOTE", `promisor remote ${remote} changed since clone`);
  }
}

function promisedBlobDetails(repo: Repository, oids: readonly string[]): PromisedBlob[] {
  const promised: PromisedBlob[] = [];
  for (let offset = 0; offset < oids.length; offset += PROMISOR_LOOKUP_PAGE) {
    promised.push(
      ...repo.store.promisedMissingDetails(oids.slice(offset, offset + PROMISOR_LOOKUP_PAGE)),
    );
  }
  return promised;
}

/** Fetch one bounded exact set of promised blobs as self-contained packs. */
export async function hydratePromisedBlobs(
  context: GitContext,
  repo: Repository,
  oids: readonly string[],
  options: RemoteAuthOptions & AbortableNetworkOptions = {},
): Promise<void> {
  validateRemoteAuthOptions(options);
  validateAbortableNetworkOptions(options);
  throwIfAborted(options.signal);
  const unique = [...new Set(oids)];
  if (unique.length > MAX_PROTOCOL_NEGOTIATION_ENTRIES) {
    throw new GitError(
      "E2BIG",
      `promisor hydration exceeds ${MAX_PROTOCOL_NEGOTIATION_ENTRIES} objects`,
    );
  }
  const promised = promisedBlobDetails(repo, unique);
  if (promised.length === 0) return;
  const byRemote = new Map<string, string[]>();
  for (const blob of promised) {
    const group = byRemote.get(blob.remoteName);
    if (group === undefined) byRemote.set(blob.remoteName, [blob.oid]);
    else group.push(blob.oid);
  }
  for (const [remote, wants] of byRemote) {
    throwIfAborted(options.signal);
    const promisor = repo.store.readPromisorRemote(remote);
    if (promisor === null) throw new CorruptError(`promisor remote ${remote} is missing`);
    const configured = remoteUrlFor(repo, remote);
    if (configured === undefined || normalizeRemoteUrl(configured) !== promisor.url) {
      throw new GitError("EPROMISORREMOTE", `promisor remote ${remote} changed since clone`);
    }
    const headers = options.headers ?? context.promisorHeaders;
    const onAuth = options.onAuth ?? context.promisorAuth;
    const auth = createRemoteAuth(
      context,
      {
        ...(headers === undefined ? {} : { headers }),
        ...(onAuth === undefined ? {} : { onAuth }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
      },
      options.signal,
    );
    const advertisement = await fetchAdvertisement(promisor.url, auth);
    const transfer = await transferPack(
      context,
      repo,
      {
        url: promisor.url,
        wants,
        shallows: [],
        advertised: advertisement.capabilities,
        useLocalHaves: false,
      },
      auth,
      fetchProgressSink(options.onProgress, options.onMessage),
      undefined,
    );
    if (transfer.shallow.length > 0 || transfer.unshallow.length > 0) {
      throw new CorruptError("promisor hydration received an unsolicited shallow response");
    }
    requireHydratedBlobs(repo, wants, options.signal);
  }
}

// A missing want outranks a wrong type, so every page is checked before the type failure.
function requireHydratedBlobs(
  repo: Repository,
  wants: readonly string[],
  signal: AbortSignal | undefined,
): void {
  let nonBlob: string | undefined;
  for (let offset = 0; offset < wants.length; offset += MAX_BLOB_BATCH_OIDS) {
    throwIfAborted(signal);
    let page: ObjectReadInfo[];
    try {
      page = repo.store.objectInfo(wants.slice(offset, offset + MAX_BLOB_BATCH_OIDS));
    } catch (error) {
      if (!hasErrorCode(error, "ENOTFOUND")) throw error;
      throw new GitError("EFETCHFAIL", "promisor remote did not return every requested blob");
    }
    nonBlob ??= page.find((entry) => entry.type !== "blob")?.oid;
  }
  if (nonBlob !== undefined) {
    throw new CorruptError(`promisor returned a non-blob object for ${nonBlob}`);
  }
}

/** Retry one synchronous operation after bounded exact-OID hydration batches. */
export async function withPromisorHydration<T>(
  context: GitContext,
  repo: Repository,
  body: () => T,
  options: AbortableNetworkOptions = {},
): Promise<T> {
  validateAbortableNetworkOptions(options);
  const requested = new Set<string>();
  for (;;) {
    throwIfAborted(options.signal);
    try {
      return body();
    } catch (error) {
      const oids = promisedObjectOids(error);
      if (oids === null) throw error;
      const before = requested.size;
      for (const oid of oids) requested.add(oid);
      if (requested.size === before) throw error;
      if (requested.size > MAX_PROTOCOL_NEGOTIATION_ENTRIES) {
        throw new GitError(
          "E2BIG",
          `operation requires more than ${MAX_PROTOCOL_NEGOTIATION_ENTRIES} promised blobs`,
        );
      }
      await hydratePromisedBlobs(context, repo, oids, options);
    }
  }
}

/** Hydrate selected checkout blobs in bounded negotiations. */
export async function hydrateTreeBlobs(
  context: GitContext,
  repo: Repository,
  treeOid: string,
  paths: string[] | undefined,
  options: RemoteAuthOptions & AbortableNetworkOptions = {},
): Promise<void> {
  validateRemoteAuthOptions(options);
  validateAbortableNetworkOptions(options);
  throwIfAborted(options.signal);
  for (;;) {
    const promised = new Set<string>();
    let candidates: string[] = [];
    const flush = (): void => {
      for (const oid of repo.store.promisedMissing(candidates)) {
        promised.add(oid);
        if (promised.size === MAX_PROTOCOL_NEGOTIATION_ENTRIES) break;
      }
      candidates = [];
    };
    // Close the tree cursor before network I/O and pack publication. Hydrated
    // objects disappear from promisedMissing on the next pass.
    for (const entry of treeStream(repo, treeOid)) {
      throwIfAborted(options.signal);
      if (entry.mode === "160000" || !matchesPaths(entry.path, paths)) continue;
      candidates.push(entry.oid);
      if (candidates.length === PROMISOR_LOOKUP_PAGE) flush();
      if (promised.size === MAX_PROTOCOL_NEGOTIATION_ENTRIES) break;
    }
    flush();
    if (promised.size === 0) return;
    await hydratePromisedBlobs(context, repo, [...promised], options);
    if (promised.size < MAX_PROTOCOL_NEGOTIATION_ENTRIES) return;
  }
}
