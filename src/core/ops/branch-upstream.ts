import { isOid, utf8 } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import { requireBranchRef } from "../protocol/receive-pack.js";
import type { Repository } from "../repository.js";

const HEADS = "refs/heads/";
const STATUS_BRANCH_REF_BYTES = 1_024;
const STATUS_REMOTE_BYTES = 255;
const STATUS_FETCH_BYTES = 2_048;

export interface ResolvedBranchUpstream {
  name: string;
  ref: string;
  oid: string | null;
}

/** Resolve one branch's configured local or remote-tracking upstream. */
export function resolveBranchUpstream(
  repo: Repository,
  headRef: string,
): ResolvedBranchUpstream | undefined {
  const checkedHeadRef = boundedBranchRef(headRef, "branch upstream ref");
  const branch = checkedHeadRef.slice(HEADS.length);
  const remote = repo.store.configGetBounded(`branch.${branch}.remote`, STATUS_REMOTE_BYTES);
  const configuredMerge = repo.store.configGetBounded(
    `branch.${branch}.merge`,
    STATUS_BRANCH_REF_BYTES,
  );
  if (remote === undefined || configuredMerge === undefined) return undefined;
  const mergeRef = boundedBranchRef(configuredMerge, "status upstream ref");
  const upstreamBranch = mergeRef.slice(HEADS.length);

  if (remote === ".") {
    return {
      name: upstreamBranch,
      ref: mergeRef,
      oid: directRefOid(repo, mergeRef),
    };
  }
  requireStatusRemote(remote);
  const fetch = repo.store.configGetBounded(`remote.${remote}.fetch`, STATUS_FETCH_BYTES);
  const expected = `refs/heads/*:refs/remotes/${remote}/*`;
  if (fetch !== expected && fetch !== `+${expected}`) return undefined;
  const trackingRef = `refs/remotes/${remote}/${upstreamBranch}`;
  return {
    name: `${remote}/${upstreamBranch}`,
    ref: trackingRef,
    oid: directRefOid(repo, trackingRef),
  };
}

export function boundedBranchRef(value: string, label: string): string {
  if (utf8.encode(value).length > STATUS_BRANCH_REF_BYTES) {
    throw new GitError("E2BIG", `${label} exceeds ${STATUS_BRANCH_REF_BYTES} bytes`);
  }
  return requireBranchRef(value.startsWith("refs/") ? value : `${HEADS}${value}`);
}

function requireStatusRemote(remote: string): void {
  if (
    remote.length === 0 ||
    remote.startsWith("/") ||
    remote.endsWith("/") ||
    remote.includes("//") ||
    remote.includes("..") ||
    remote.includes("@{") ||
    remote.includes("\\")
  ) {
    throw new GitError("EINVAL", `invalid status remote ${remote}`);
  }
  for (const character of remote) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || "~^:?*[".includes(character)) {
      throw new GitError("EINVAL", `invalid status remote ${remote}`);
    }
  }
}

export function directRefOid(repo: Repository, ref: string): string | null {
  const target: unknown = repo.store.getRef(ref);
  if (target === null) return null;
  if (typeof target !== "string" || !isOid(target)) {
    throw new CorruptError(`status ref ${ref} does not contain a full object id`);
  }
  return target;
}
