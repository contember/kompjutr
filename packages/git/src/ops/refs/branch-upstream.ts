import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../../common/ref-name.js";
import {
  expandRefOwned,
  type Repository,
  readRawRefOwned,
  symbolicTargetOwned,
} from "../repository/repository.js";

const HEADS = "refs/heads/";
const REMOTES = "refs/remotes/";

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
  const remotePath = `branch.${branch}.remote`;
  const mergePath = `branch.${branch}.merge`;
  const remote = repo.store.configGetBounded(remotePath);
  if (remote === undefined) return undefined;
  const configuredMerge = repo.store.configGetBounded(mergePath);
  if (configuredMerge === undefined) return undefined;
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
  if (!fetchesIntoTracking(repo, remote)) return undefined;
  const trackingRef = `refs/remotes/${remote}/${upstreamBranch}`;
  return {
    name: `${remote}/${upstreamBranch}`,
    ref: trackingRef,
    oid: directRefOid(repo, trackingRef),
  };
}

export interface BranchUpstreamConfig {
  remote: string;
  merge: string;
}

/**
 * The upstream git's default `branch.autoSetupMerge=true` records for a new
 * branch: only a start point naming a remote-tracking ref of a remote tracks.
 */
export function startPointUpstream(
  repo: Repository,
  startPoint: string,
): BranchUpstreamConfig | undefined {
  if (checkRefText(startPoint).problem !== null || !hasCanonicalRefSyntax(startPoint)) {
    return undefined;
  }
  let ref = expandRefOwned(repo, startPoint);
  // `origin` names the symbolic `origin/HEAD`; git tracks the branch it points at.
  for (let hops = 0; ref !== null && hops < 8; hops++) {
    const raw = readRawRefOwned(repo, ref);
    const target = raw === null ? null : symbolicTargetOwned(raw);
    if (target === null) break;
    ref = target;
  }
  if (ref === null || !ref.startsWith(REMOTES)) return undefined;
  const tracked = ref.slice(REMOTES.length);
  const matches: BranchUpstreamConfig[] = [];
  for (let slash = tracked.indexOf("/"); slash > 0; slash = tracked.indexOf("/", slash + 1)) {
    const remote = tracked.slice(0, slash);
    if (fetchesIntoTracking(repo, remote)) {
      matches.push({ remote, merge: `${HEADS}${tracked.slice(slash + 1)}` });
    }
  }
  if (matches.length > 1) {
    throw new GitError("EBRANCHFAIL", `not tracking: ambiguous information for ref '${ref}'`);
  }
  return matches[0];
}

/** The one fetch refspec kompjutr maps: the remote's heads into its tracking refs. */
function fetchesIntoTracking(repo: Repository, remote: string): boolean {
  const fetch = repo.store.configGetBounded(`remote.${remote}.fetch`);
  const expected = `refs/heads/*:refs/remotes/${remote}/*`;
  return fetch === expected || fetch === `+${expected}`;
}

export function boundedBranchRef(value: string, label: string): string {
  const full = value.startsWith("refs/") ? value : `${HEADS}${value}`;
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

export function directRefOid(repo: Repository, ref: string): string | null {
  const target: unknown = repo.store.getRef(ref);
  if (target === null) return null;
  if (typeof target !== "string" || !isOid(target)) {
    throw new CorruptError(`status ref ${ref} does not contain a full object id`);
  }
  return target;
}
