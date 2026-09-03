import { isOid } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import {
  requireBranchRef,
  validatePushOptions as validateReceivePushOptions,
} from "../protocol/receive-pack.js";
import {
  remoteUrlFor,
  validateAbortableNetworkOptions,
  validateRemoteAuthOptions,
} from "./network.js";
import type { LegacyPushSelection, PushOptions } from "./push-types.js";
import type { NormalizedPushLease, PushRefspec, RefspecSourceRef } from "./refspec.js";
import type { Repository } from "./repository.js";

export function validatePushOperationOptions(options: unknown): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitError("EINVAL", "push options must be an object");
  }
  validateRemoteAuthOptions(options);
  validateAbortableNetworkOptions(options);
  const remote = Reflect.get(options, "remote");
  const url = Reflect.get(options, "url");
  if (remote !== undefined && url !== undefined) {
    throw new GitError("EINVAL", "push accepts either remote or url, not both");
  }
  if (remote !== undefined && (typeof remote !== "string" || remote === "")) {
    throw new GitError("EINVAL", "push remote must be a non-empty string");
  }
  if (url !== undefined && typeof url !== "string") {
    throw new GitError("EINVAL", "push url must be a string");
  }
  const atomic = Reflect.get(options, "atomic");
  if (atomic !== undefined && typeof atomic !== "boolean") {
    throw new GitError("EINVAL", "push atomic must be a boolean");
  }
  validateReceivePushOptions(Reflect.get(options, "pushOptions"));

  const refspecs = Reflect.get(options, "refspecs");
  if (refspecs !== undefined) {
    if (!Array.isArray(refspecs)) throw new GitError("EINVAL", "push refspecs must be an array");
    for (const field of ["ref", "remoteRef", "force", "delete"]) {
      if (Reflect.get(options, field) !== undefined) {
        throw new GitError("EINVAL", `mapped push cannot set ${field}`);
      }
    }
    return;
  }
  for (const field of ["ref", "remoteRef"]) {
    const value = Reflect.get(options, field);
    if (value !== undefined && typeof value !== "string") {
      throw new GitError("EINVAL", `push ${field} must be a string`);
    }
  }
  for (const field of ["force", "delete"]) {
    const value = Reflect.get(options, field);
    if (value !== undefined && typeof value !== "boolean") {
      throw new GitError("EINVAL", `push ${field} must be a boolean`);
    }
  }
}

function fullBranchRef(ref: string): string {
  return requireBranchRef(ref.startsWith("refs/") ? ref : `refs/heads/${ref}`);
}

function localBranch(repo: Repository, requested: string | undefined): string {
  if (requested !== undefined) return fullBranchRef(requested);
  const head = repo.head();
  if (head.ref === null) {
    throw new GitError("EDETACHED", "push from detached HEAD requires an explicit branch ref");
  }
  return requireBranchRef(head.ref);
}

function targetBranch(
  repo: Repository,
  localRef: string,
  remote: string,
  requested: string | undefined,
): string {
  if (requested !== undefined) return fullBranchRef(requested);
  const branch = localRef.slice("refs/heads/".length);
  const upstreamRemote = repo.store.configGet(`branch.${branch}.remote`);
  const merge = repo.store.configGet(`branch.${branch}.merge`);
  if ((upstreamRemote === undefined || upstreamRemote === remote) && merge !== undefined) {
    return fullBranchRef(merge);
  }
  return localRef;
}

export function legacyRefspecs(
  repo: Repository,
  options: PushOptions & LegacyPushSelection,
  remote: string,
): readonly [PushRefspec] {
  const localRef =
    options.delete === true && options.ref === undefined && options.remoteRef !== undefined
      ? fullBranchRef(options.remoteRef)
      : localBranch(repo, options.ref);
  const destination = targetBranch(repo, localRef, remote, options.remoteRef);
  return options.delete === true
    ? [{ source: null, destination }]
    : [{ source: localRef, destination, force: options.force === true }];
}

function resolveRawLocalRef(name: string, refs: ReadonlyMap<string, string>): string | null {
  let current = name;
  for (let hops = 0; hops < 8; hops++) {
    const target = refs.get(current);
    if (target === undefined) return null;
    if (isOid(target)) return target;
    if (!target.startsWith("ref: ")) {
      throw new CorruptError(`stored ref ${current} has an invalid symbolic target`);
    }
    current = target.slice(5);
  }
  throw new CorruptError(`symbolic ref loop at ${name}`);
}

export function localRefSnapshot(repo: Repository): RefspecSourceRef[] {
  const raw = new Map<string, string>();
  for (const row of repo.store.iterateRefs()) {
    raw.set(row.name, row.target);
  }

  const result: RefspecSourceRef[] = [];
  for (const name of raw.keys()) {
    const oid = resolveRawLocalRef(name, raw);
    if (oid === null) continue;
    result.push({ name, oid });
  }
  return result;
}

export function needsLocalRefs(refspecs: readonly PushRefspec[]): boolean {
  for (const refspec of refspecs) {
    if (refspec.source !== null && !isOid(refspec.source)) return true;
  }
  return false;
}

export function pushTarget(
  repo: Repository,
  options: PushOptions,
): { readonly remote: string; readonly url: string; readonly configured: boolean } {
  const remote = options.remote ?? "origin";
  if (options.url !== undefined) return { remote, url: options.url, configured: false };
  const pushUrl = repo.store.configGet(`remote.${remote}.pushurl`);
  const url = pushUrl ?? remoteUrlFor(repo, remote);
  if (url === undefined) throw new GitError("ENOREMOTE", `no such remote: ${remote}`);
  return { remote, url, configured: true };
}

export function snapshotPushLeases(
  repo: Repository,
  leases: readonly NormalizedPushLease[],
  target: { readonly remote: string; readonly configured: boolean },
): ReadonlyMap<string, string | null> {
  const snapshot = new Map<string, string | null>();
  let raw: Map<string, string> | null = null;
  for (const lease of leases) {
    if ("expected" in lease.expectation) {
      snapshot.set(lease.destination, lease.expectation.expected);
      continue;
    }
    if (!target.configured) {
      throw new GitError("EINVAL", "tracking push leases require a configured named remote");
    }
    if (!lease.destination.startsWith("refs/heads/")) {
      throw new GitError("EINVAL", "tracking push leases require branch destinations");
    }
    if (raw === null) {
      raw = new Map<string, string>();
      for (const row of repo.store.iterateRefs()) raw.set(row.name, row.target);
    }
    const tracking = trackingName(`refs/remotes/${target.remote}/`, lease.destination);
    const expected = resolveRawLocalRef(tracking, raw);
    if (expected === null) {
      throw new GitError("EREFNOTFOUND", `tracking ref not found for push lease: ${tracking}`);
    }
    snapshot.set(lease.destination, expected);
  }
  return snapshot;
}

export function trackingName(prefix: string, destination: string): string {
  return `${prefix}${destination.slice("refs/heads/".length)}`;
}
