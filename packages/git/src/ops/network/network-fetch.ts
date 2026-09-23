import { GitError } from "../../common/errors.js";
import { throwIfAborted } from "../../protocol/stream.js";
import type { GitContext } from "../core/context.js";
import { compileFetchRefspecs } from "../refs/refspec.js";
import type { Repository } from "../repository/repository.js";
import { runFetchCheckpoint } from "./network-checkpoint.js";
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
import { lowerLegacyFetch } from "./network-selection.js";
import { fetchAdvertisement } from "./network-transfer.js";
import type {
  FetchBehavior,
  FetchOperationOptions,
  FetchResult,
  FetchTarget,
  MappedFetchPlan,
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
  if (options.filter !== undefined) requirePartialFetchTarget(repo, target.remote, target.url);
  const auth = fetchAuth(context, options);
  await runFetchCheckpoint(behavior.checkpoint, "before-discovery", options.signal);
  const advertisement = await fetchAdvertisement(target.url, auth);
  throwIfAborted(options.signal);
  const defaultBranch = advertisement.headRef;
  const run = (plan: MappedFetchPlan) =>
    fetchMappedInto(
      context,
      repo,
      options,
      behavior,
      refLogReason,
      target,
      advertisement,
      auth,
      plan,
    );

  if (isMappedFetchOptions(options)) {
    if (compiler === undefined) throw new Error("mapped fetch lost its compiled refspecs");
    const refs = compiler.expand(advertisement.refs);
    if (refs.length === 0) {
      await runFetchCheckpoint(behavior.checkpoint, "after-discovery", options.signal);
      return { mode: "mapped", defaultBranch, fetchHead: null, updates: [] };
    }
    await run({
      roots: refs.map((ref) => ({ name: ref.source, oid: ref.oid })),
      updates: refs,
      followTags: false,
    });
    return {
      mode: "mapped",
      defaultBranch,
      fetchHead: null,
      updates: refs.map((ref) => ({
        source: ref.source,
        destination: ref.destination,
        oid: ref.oid,
      })),
    };
  }
  const lowered = lowerLegacyFetch(advertisement, options, behavior, target);
  await run(lowered.plan);
  return { mode: "legacy", defaultBranch, fetchHead: lowered.fetchHead, updates: [] };
}
