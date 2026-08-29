import { createRefMutationMemoryOwner, type RefMutationMemoryOwner } from "../../sqlite/store.js";
import { isOid } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../ref-name.js";
import type { Repository } from "../repository.js";

const HEADS = "refs/heads/";

export interface ResolvedBranchUpstream {
  name: string;
  ref: string;
  oid: string | null;
}

/** Resolve one branch's configured local or remote-tracking upstream. */
export function resolveBranchUpstream(
  repo: Repository,
  headRef: string,
  callerOwner?: RefMutationMemoryOwner,
): ResolvedBranchUpstream | undefined {
  const owner = callerOwner ?? createRefMutationMemoryOwner(repo.store);
  try {
    const checkedHeadRef = boundedBranchRef(headRef, "branch upstream ref", owner);
    const branch = owner.construct(checkedHeadRef.length - HEADS.length, () =>
      checkedHeadRef.slice(HEADS.length),
    );
    const remotePath = owner.construct(
      "branch..remote".length + branch.length,
      () => `branch.${branch}.remote`,
    );
    const mergePath = owner.construct(
      "branch..merge".length + branch.length,
      () => `branch.${branch}.merge`,
    );
    const remote = repo.store.configGetBounded(remotePath);
    if (remote === undefined) return undefined;
    retainOwned(owner, remote);
    const configuredMerge = repo.store.configGetBounded(mergePath);
    if (configuredMerge === undefined) return undefined;
    retainOwned(owner, configuredMerge);
    const mergeRef = boundedBranchRef(configuredMerge, "status upstream ref", owner);
    const upstreamBranch = owner.construct(mergeRef.length - HEADS.length, () =>
      mergeRef.slice(HEADS.length),
    );

    if (remote === ".") {
      return {
        name: upstreamBranch,
        ref: mergeRef,
        oid: directRefOid(repo, mergeRef, owner),
      };
    }
    requireStatusRemote(remote);
    const fetchPath = owner.construct(
      "remote..fetch".length + remote.length,
      () => `remote.${remote}.fetch`,
    );
    const fetch = repo.store.configGetBounded(fetchPath);
    if (fetch !== undefined) retainOwned(owner, fetch);
    const expected = owner.construct(
      "refs/heads/*:refs/remotes//*".length + remote.length,
      () => `refs/heads/*:refs/remotes/${remote}/*`,
    );
    if (fetch !== expected) {
      const forcedExpected = owner.construct(1 + expected.length, () => `+${expected}`);
      if (fetch !== forcedExpected) return undefined;
    }
    const trackingRef = owner.construct(
      "refs/remotes//".length + remote.length + upstreamBranch.length,
      () => `refs/remotes/${remote}/${upstreamBranch}`,
    );
    return {
      name: owner.construct(
        remote.length + 1 + upstreamBranch.length,
        () => `${remote}/${upstreamBranch}`,
      ),
      ref: trackingRef,
      oid: directRefOid(repo, trackingRef, owner),
    };
  } finally {
    if (callerOwner === undefined) owner.dispose();
  }
}

export function boundedBranchRef(
  value: string,
  label: string,
  owner?: RefMutationMemoryOwner,
): string {
  const full = value.startsWith("refs/")
    ? value
    : (owner?.construct(HEADS.length + value.length, () => `${HEADS}${value}`) ??
      `${HEADS}${value}`);
  if (
    checkRefText(full).problem !== null ||
    !full.startsWith(HEADS) ||
    full.length === HEADS.length ||
    !hasCanonicalRefSyntax(full)
  ) {
    throw new GitError("EINVALIDREF", `${label} is not a canonical branch ref`);
  }
  return full;
}

function retainOwned<T extends string>(owner: RefMutationMemoryOwner, value: T): T {
  return owner.owns(value) ? value : owner.retain(value);
}

function requireStatusRemote(remote: string): void {
  if (
    checkRefText(remote).problem !== null ||
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

export function directRefOid(
  repo: Repository,
  ref: string,
  owner?: RefMutationMemoryOwner,
): string | null {
  const target: unknown = repo.store.getRef(ref);
  if (target === null) return null;
  if (typeof target !== "string" || !isOid(target)) {
    throw new CorruptError(`status ref ${ref} does not contain a full object id`);
  }
  return owner === undefined ? target : retainOwned(owner, target);
}
