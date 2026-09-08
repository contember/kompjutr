import { GitError } from "../../common/errors.js";
import { throwIfAborted } from "../../protocol/stream.js";
import type { GitContext } from "../core/context.js";
import { compileFetchRefspecs } from "../refs/refspec.js";
import type { Repository } from "../repository/repository.js";
import { runFetchCheckpoint } from "./network-checkpoint.js";
import { fetchLegacyInto } from "./network-fetch-legacy.js";
import { fetchMappedInto } from "./network-fetch-mapped.js";
import {
  fetchAuth,
  remoteUrlFor,
  sameRemoteUrl,
  validateAbortableNetworkOptions,
  validateFetchOptions,
  validateLegacyDeepeningOptions,
  validateRemoteAuthOptions,
} from "./network-options.js";
import { requirePartialFetchTarget } from "./network-promisor.js";
import { fetchAdvertisement } from "./network-transfer.js";
import type {
  FetchBehavior,
  FetchOperationOptions,
  FetchResult,
  FetchTarget,
  MappedFetchSelection,
} from "./network-types.js";

function isMappedFetchOptions(
  options: FetchOperationOptions,
): options is FetchOperationOptions & MappedFetchSelection {
  return options.refspecs !== undefined;
}

function fetchRemoteUrl(repo: Repository, options: FetchOperationOptions): FetchTarget {
  if (options.url !== undefined) {
    if (typeof options.url !== "string") throw new GitError("EINVAL", "fetch url must be a string");
    const remote = options.remote ?? "origin";
    const existing = remoteUrlFor(repo, remote);
    // A public fetch names only a URL, and an arbitrary repository owns no tracking
    // namespace. Naming the remote too is internal: it pins a name that is still unset.
    const configured =
      existing === undefined ? options.remote !== undefined : sameRemoteUrl(existing, options.url);
    return { remote, url: options.url, configured };
  }
  if (
    options.remote !== undefined &&
    (typeof options.remote !== "string" || options.remote === "")
  ) {
    throw new GitError("EINVAL", "fetch remote must be a non-empty string");
  }
  const remote = options.remote ?? "origin";
  const url = remoteUrlFor(repo, remote);
  if (url === undefined) throw new GitError("ENOREMOTE", `no such remote: ${remote}`);
  return { remote, url, configured: true };
}

export async function fetchInto(
  context: GitContext,
  repo: Repository,
  options: FetchOperationOptions,
  refLogReason: "fetch" | "clone: fetch" = "fetch",
  behavior: FetchBehavior = {},
): Promise<FetchResult> {
  if (isMappedFetchOptions(options)) validateFetchOptions(options);
  else {
    validateRemoteAuthOptions(options);
    validateAbortableNetworkOptions(options);
    validateLegacyDeepeningOptions(options);
  }
  throwIfAborted(options.signal);
  if (!isMappedFetchOptions(options) && options.unshallow === true && repo.shallow().size === 0) {
    throw new GitError("EINVAL", "cannot unshallow a complete repository");
  }
  const compiler = isMappedFetchOptions(options)
    ? compileFetchRefspecs(options.refspecs)
    : undefined;
  const target = fetchRemoteUrl(repo, options);
  const { remote, url } = target;
  if (options.filter !== undefined) requirePartialFetchTarget(repo, remote, url);
  const auth = fetchAuth(context, options);
  await runFetchCheckpoint(behavior.checkpoint, "before-discovery", options.signal);
  const advertisement = await fetchAdvertisement(url, auth);
  throwIfAborted(options.signal);
  if (isMappedFetchOptions(options)) {
    if (compiler === undefined) throw new Error("mapped fetch lost its compiled refspecs");
    return await fetchMappedInto(
      context,
      repo,
      options,
      behavior,
      refLogReason,
      remote,
      url,
      advertisement,
      auth,
      compiler.expand(advertisement.refs),
    );
  }
  return await fetchLegacyInto(
    context,
    repo,
    options,
    behavior,
    refLogReason,
    target,
    advertisement,
    auth,
  );
}
