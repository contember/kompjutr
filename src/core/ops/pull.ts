// Pull preflight: resolve one checked-out branch and its remote upstream before
// any asynchronous network work begins.

import { isOid } from "../bytes.js";
import type { GitContext, GitIdentity } from "../context.js";
import { CorruptError, GitError, UnsupportedOperationError } from "../errors.js";
import { normalizeRemoteUrl } from "../protocol/remote.js";
import { checkRefText, hasCanonicalRefSyntax } from "../ref-name.js";
import { type Repository, resolveHeadOwned } from "../repository.js";
import type { Worktree } from "../worktree.js";
import type { MergeResult } from "./kinds.js";
import { type MergeBehavior, mergeOwned } from "./merge.js";
import { fetchInto, type RemoteAuthOptions } from "./network.js";

const HEADS = "refs/heads/";
const FALSE_CONFIG_VALUES = new Set(["", "0", "false", "no", "off"]);
const TRUE_CONFIG_VALUES = new Set(["1", "true", "yes", "on"]);

export interface PullOptions extends RemoteAuthOptions {
  remote?: string;
  url?: string;
  /** Local branch to validate. Pull never targets an inactive branch. */
  ref?: string;
  /** Remote branch to fetch and integrate. */
  remoteRef?: string;
  fastForward?: boolean;
  fastForwardOnly?: boolean;
  singleBranch?: boolean;
  author?: GitIdentity;
  committer?: GitIdentity;
  env?: Record<string, string>;
  /** Native-only: leave a clean divergent integration pending. */
  commit?: boolean;
  /** Native-only: override the merge commit message. */
  message?: string;
}

export interface PullPlan {
  headRef: string;
  headOid: string;
  branch: string;
  remote: string;
  url: string;
  displayUrl: string;
  remoteRef: string;
  remoteBranch: string;
  fetchRefspec: string;
  fetchSingleBranch: boolean;
  fetchAutoTags: boolean;
  fastForward?: boolean;
  fastForwardOnly?: boolean;
}

function canonicalText(value: string, label: string): string {
  if (value.length === 0) throw new GitError("EINVAL", `${label} is empty`);
  if (checkRefText(value).problem !== null) throw new GitError("EINVAL", `${label} is invalid`);
  return value;
}

function fullBranchRef(value: string, label: string): string {
  if (value.length === 0 || checkRefText(value).problem !== null) {
    throw new GitError("EINVALIDREF", `${label} is not a canonical branch ref`);
  }
  const checkedValue = value;
  const fullRef = checkedValue.startsWith("refs/") ? checkedValue : `${HEADS}${checkedValue}`;
  if (
    !fullRef.startsWith(HEADS) ||
    fullRef.length === HEADS.length ||
    !hasCanonicalRefSyntax(fullRef)
  ) {
    throw new GitError("EINVALIDREF", `${label} is not a canonical branch ref`);
  }
  return fullRef;
}

function pullUrl(value: string): Pick<PullPlan, "url" | "displayUrl"> {
  const checkedUrl = canonicalText(value, "pull URL");
  let parsed: URL;
  try {
    parsed = new URL(checkedUrl);
  } catch {
    throw new GitError("EINVAL", "pull URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GitError("EURLSCHEME", "pull URL uses an unsupported scheme");
  }
  const url = normalizeRemoteUrl(checkedUrl);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const serialized = parsed.toString();
  const displayUrl = serialized.endsWith("/") ? serialized.slice(0, -1) : serialized;
  return { url, displayUrl };
}

function requireRemoteName(value: string): string {
  const remote = canonicalText(value, "pull remote");
  if (remote === ".") {
    throw new UnsupportedOperationError("pull from a local repository");
  }
  if (
    remote.startsWith("/") ||
    remote.endsWith("/") ||
    remote.includes("//") ||
    remote.includes("..") ||
    remote.includes("@{") ||
    remote.includes("\\")
  ) {
    throw new GitError("EINVAL", `invalid pull remote ${remote}`);
  }
  for (const character of remote) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || "~^:?*[".includes(character)) {
      throw new GitError("EINVAL", `invalid pull remote ${remote}`);
    }
  }
  return remote;
}

function configured(repo: Repository, path: string, limit?: number): string | undefined {
  return repo.store.configGetBounded(path, limit);
}

function parseBooleanConfig(value: string, path: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (TRUE_CONFIG_VALUES.has(normalized)) return true;
  if (FALSE_CONFIG_VALUES.has(normalized)) return false;
  throw new GitError("EINVAL", `config ${path} has invalid boolean value ${value}`);
}

function fastForwardOptions(
  repo: Repository,
  options: PullOptions,
): Pick<PullPlan, "fastForward" | "fastForwardOnly"> {
  if (options.fastForwardOnly === true && options.fastForward === false) {
    throw new GitError("EINVAL", "pull fastForwardOnly conflicts with fastForward: false");
  }
  if (options.fastForwardOnly !== undefined || options.fastForward !== undefined) {
    return {
      ...(options.fastForward === undefined ? {} : { fastForward: options.fastForward }),
      ...(options.fastForwardOnly === undefined
        ? {}
        : { fastForwardOnly: options.fastForwardOnly }),
    };
  }
  const configuredFf = configured(repo, "pull.ff");
  if (configuredFf === undefined) return {};
  const normalized = configuredFf.trim().toLowerCase();
  if (normalized === "only") return { fastForwardOnly: true };
  return { fastForward: parseBooleanConfig(normalized, "pull.ff") };
}

function requireMergeStrategy(repo: Repository): void {
  const rebase = configured(repo, "pull.rebase");
  if (rebase === undefined) return;
  const normalized = rebase.trim().toLowerCase();
  if (FALSE_CONFIG_VALUES.has(normalized)) return;
  if (
    TRUE_CONFIG_VALUES.has(normalized) ||
    normalized === "m" ||
    normalized === "merges" ||
    normalized === "i" ||
    normalized === "interactive"
  ) {
    throw new UnsupportedOperationError("rebase-based pull");
  }
  throw new GitError("EINVAL", `config pull.rebase has invalid value ${rebase}`);
}

function pullFetchShape(
  repo: Repository,
  remote: string,
  remoteRef: string,
  options: PullOptions,
): Pick<PullPlan, "fetchRefspec" | "fetchSingleBranch" | "fetchAutoTags"> {
  const explicitRemoteRef = options.remoteRef !== undefined;
  const fetchSingleBranch = options.singleBranch ?? explicitRemoteRef;
  if (fetchSingleBranch) {
    return {
      fetchRefspec: remoteRef,
      fetchSingleBranch: true,
      fetchAutoTags: !explicitRemoteRef,
    };
  }

  const canonical = `+refs/heads/*:refs/remotes/${remote}/*`;
  const fetchPath = `remote.${remote}.fetch`;
  const configuredFetch = configured(repo, fetchPath);
  if (configuredFetch !== undefined && configuredFetch !== canonical) {
    throw new UnsupportedOperationError("custom pull fetch refspec");
  }
  return {
    fetchRefspec: canonical,
    fetchSingleBranch: false,
    fetchAutoTags: true,
  };
}

/** Resolve and validate everything pull needs before it starts network work. */
export function resolvePull(repo: Repository, options: PullOptions = {}): PullPlan {
  return resolvePullOwned(repo, options);
}

function resolvePullOwned(repo: Repository, options: PullOptions): PullPlan {
  repo.checkout.requireNoMergeState();
  const head = resolveHeadOwned(repo);
  if (head.ref === null) throw new GitError("EDETACHED", "cannot pull with a detached HEAD");
  if (head.oid === null) throw new GitError("ENOCOMMIT", "cannot pull into an unborn branch");
  if (typeof head.oid !== "string" || !isOid(head.oid)) {
    throw new CorruptError("checked-out branch has an invalid target");
  }
  repo.readCommit(repo.peel(head.oid));
  const headRef = fullBranchRef(head.ref, "pull HEAD ref");
  const branch = headRef.slice(HEADS.length);
  if (options.ref !== undefined && fullBranchRef(options.ref, "pull local ref") !== headRef) {
    throw new GitError("EWRONGHEAD", `pull target ${options.ref} is not the checked-out branch`);
  }
  const configuredRemote =
    options.remote === undefined ? configured(repo, `branch.${branch}.remote`) : undefined;
  const remoteValue = options.remote ?? configuredRemote;
  if (remoteValue === undefined && options.url === undefined) {
    throw new GitError("ENOUPSTREAM", `branch ${branch} has no configured upstream remote`);
  }
  const remote = requireRemoteName(remoteValue ?? "origin");

  const configuredMerge =
    options.remoteRef === undefined ? configured(repo, `branch.${branch}.merge`) : undefined;
  const remoteRefValue = options.remoteRef ?? configuredMerge;
  if (remoteRefValue === undefined) {
    throw new GitError("ENOUPSTREAM", `branch ${branch} has no configured upstream branch`);
  }
  const remoteRef = fullBranchRef(remoteRefValue, "pull remote ref");
  const remoteBranch = remoteRef.slice(HEADS.length);

  const configuredUrl =
    options.url === undefined ? configured(repo, `remote.${remote}.url`) : undefined;
  const urlValue = options.url ?? configuredUrl;
  if (urlValue === undefined) throw new GitError("ENOREMOTE", `no such remote: ${remote}`);
  const resolvedUrl = pullUrl(urlValue);
  const fetchShape = pullFetchShape(repo, remote, remoteRef, options);

  requireMergeStrategy(repo);
  const plan: PullPlan = {
    headRef,
    headOid: head.oid,
    branch,
    remote,
    ...resolvedUrl,
    remoteRef,
    remoteBranch,
    ...fetchShape,
    ...fastForwardOptions(repo, options),
  };
  return plan;
}

function sameTarget(left: PullPlan, right: PullPlan): boolean {
  return (
    left.remote === right.remote &&
    left.url === right.url &&
    left.remoteRef === right.remoteRef &&
    left.fetchRefspec === right.fetchRefspec &&
    left.fetchSingleBranch === right.fetchSingleBranch &&
    left.fetchAutoTags === right.fetchAutoTags &&
    left.fastForward === right.fastForward &&
    left.fastForwardOnly === right.fastForwardOnly
  );
}

function defaultPullMessage(plan: PullPlan): string {
  return `Merge branch '${plan.remoteBranch}' of ${plan.displayUrl}`;
}

/** Re-read post-fetch state without extending temporary allocations into merge. */
export function validatePullAfterFetch(
  repo: Repository,
  options: PullOptions,
  plan: PullPlan,
): void {
  const head = resolveHeadOwned(repo);
  if (head.ref !== plan.headRef || head.oid !== plan.headOid) {
    throw new GitError("ESTALEHEAD", "HEAD changed while pull was fetching its upstream");
  }

  repo.checkout.requireNoMergeState();

  let current: PullPlan;
  try {
    current = resolvePullOwned(repo, options);
  } catch (error) {
    throw new GitError("ESTALEUPSTREAM", "upstream configuration changed while pull was fetching", {
      cause: error,
    });
  }
  if (!sameTarget(current, plan)) {
    throw new GitError("ESTALEUPSTREAM", "upstream configuration changed while pull was fetching");
  }
}

/** Fetch one upstream and integrate it through the existing merge lifecycle. */
export async function pull(
  context: GitContext,
  repo: Repository,
  worktree: Worktree,
  options: PullOptions = {},
  behavior: MergeBehavior = {},
): Promise<MergeResult> {
  const plan = resolvePullOwned(repo, options);
  const fetched = await fetchInto(
    context,
    repo,
    {
      remote: plan.remote,
      url: plan.url,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.onAuth === undefined ? {} : { onAuth: options.onAuth }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
    },
    "fetch",
    {
      ...(plan.fetchSingleBranch ? { coverageRef: plan.remoteRef } : {}),
      resultRef: plan.remoteRef,
      autoTags: plan.fetchAutoTags,
    },
  );
  if (fetched.fetchHead === null) {
    throw new GitError("EFETCHFAIL", `remote ${plan.remote} advertised no usable upstream ref`);
  }

  validatePullAfterFetch(repo, options, plan);

  const message = options.message === undefined ? defaultPullMessage(plan) : options.message;
  return await mergeOwned(
    context,
    repo,
    worktree,
    {
      theirs: fetched.fetchHead,
      ours: plan.headRef,
      ...(plan.fastForward === undefined ? {} : { fastForward: plan.fastForward }),
      ...(plan.fastForwardOnly === undefined ? {} : { fastForwardOnly: plan.fastForwardOnly }),
      message,
      ...(options.author === undefined ? {} : { author: options.author }),
      ...(options.committer === undefined ? {} : { committer: options.committer }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.commit === undefined ? {} : { commit: options.commit }),
    },
    {
      ...behavior,
      incomingLabel: fetched.fetchHead,
      origin: "pull",
    },
  );
}
