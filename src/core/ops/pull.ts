// Pull preflight: resolve one checked-out branch and its remote upstream before
// any asynchronous network work begins.

import { isOid } from "../bytes.js";
import type { GitContext, GitIdentity } from "../context.js";
import { CorruptError, GitError, UnsupportedOperationError } from "../errors.js";
import { normalizeRemoteUrl } from "../protocol/remote.js";
import { checkRefText, hasCanonicalRefSyntax } from "../ref-name.js";
import { type Repository, resolveHeadOwned } from "../repository.js";
import { retainedStringBytes } from "../retained.js";
import type { Worktree } from "../worktree.js";
import type { MergeResult } from "./kinds.js";
import { type MergeBehavior, mergeOwned } from "./merge.js";
import { fetchInto, type RemoteAuthOptions } from "./network.js";
import type { FetchResult } from "./refspec.js";

const HEADS = "refs/heads/";
const MAX_PULL_FETCH_REFSPEC_BYTES = 2_048;
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

function fullBranchRef(value: string, label: string, owner: PullPlanOwner): string {
  if (value.length === 0 || checkRefText(value).problem !== null) {
    throw new GitError("EINVALIDREF", `${label} is not a canonical branch ref`);
  }
  const checkedValue = value;
  const fullRef = checkedValue.startsWith("refs/")
    ? checkedValue
    : owner.construct(HEADS.length + checkedValue.length, () => `${HEADS}${checkedValue}`);
  if (
    !fullRef.startsWith(HEADS) ||
    fullRef.length === HEADS.length ||
    !hasCanonicalRefSyntax(fullRef)
  ) {
    throw new GitError("EINVALIDREF", `${label} is not a canonical branch ref`);
  }
  return fullRef;
}

function pullUrl(value: string, owner: PullPlanOwner): Pick<PullPlan, "url" | "displayUrl"> {
  const checkedUrl = canonicalText(value, "pull URL");
  owner.precharge(2_048 + 72 * checkedUrl.length);
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
  owner.commitPrecharge(url === checkedUrl ? [displayUrl] : [url, displayUrl]);
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

function configured(
  repo: Repository,
  path: string,
  limit?: number,
  owner?: PullPlanOwner,
): string | undefined {
  const value = repo.store.configGetBounded(path, limit);
  if (value !== undefined) owner?.retain(value);
  return value;
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
  owner: PullPlanOwner,
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
  const configuredFf = configured(repo, "pull.ff", undefined, owner);
  if (configuredFf === undefined) return {};
  return owner.withTransientString(
    configuredFf.length,
    () => configuredFf.trim().toLowerCase(),
    (normalized) => {
      if (normalized === "only") return { fastForwardOnly: true };
      return { fastForward: parseBooleanConfig(normalized, "pull.ff") };
    },
  );
}

function requireMergeStrategy(repo: Repository, owner: PullPlanOwner): void {
  const rebase = configured(repo, "pull.rebase", undefined, owner);
  if (rebase === undefined) return;
  owner.withTransientString(
    rebase.length,
    () => rebase.trim().toLowerCase(),
    (normalized) => {
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
    },
  );
}

function pullFetchShape(
  repo: Repository,
  remote: string,
  remoteRef: string,
  options: PullOptions,
  owner: PullPlanOwner,
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

  const canonical = owner.construct(
    "+refs/heads/*:refs/remotes//*".length + remote.length,
    () => `+refs/heads/*:refs/remotes/${remote}/*`,
  );
  const fetchPath = owner.construct(
    "remote..fetch".length + remote.length,
    () => `remote.${remote}.fetch`,
  );
  const configuredFetch = configured(repo, fetchPath, MAX_PULL_FETCH_REFSPEC_BYTES, owner);
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
  const owner = new PullPlanOwner(repo);
  try {
    return resolvePullOwned(repo, options, owner);
  } finally {
    owner.dispose();
  }
}

function resolvePullOwned(repo: Repository, options: PullOptions, owner: PullPlanOwner): PullPlan {
  repo.checkout.requireNoMergeState();
  const head = resolveHeadOwned(repo, owner);
  if (head.ref === null) throw new GitError("EDETACHED", "cannot pull with a detached HEAD");
  if (head.oid === null) throw new GitError("ENOCOMMIT", "cannot pull into an unborn branch");
  if (typeof head.oid !== "string" || !isOid(head.oid)) {
    throw new CorruptError("checked-out branch has an invalid target");
  }
  repo.readCommit(repo.peel(head.oid));
  const headRef = fullBranchRef(head.ref, "pull HEAD ref", owner);
  const branch = owner.construct(headRef.length - HEADS.length, () => headRef.slice(HEADS.length));
  if (
    options.ref !== undefined &&
    fullBranchRef(options.ref, "pull local ref", owner) !== headRef
  ) {
    throw new GitError("EWRONGHEAD", `pull target ${options.ref} is not the checked-out branch`);
  }
  const configuredRemote =
    options.remote === undefined
      ? configured(
          repo,
          owner.construct("branch..remote".length + branch.length, () => `branch.${branch}.remote`),
          undefined,
          owner,
        )
      : undefined;
  const remoteValue = options.remote ?? configuredRemote;
  if (remoteValue === undefined && options.url === undefined) {
    throw new GitError("ENOUPSTREAM", `branch ${branch} has no configured upstream remote`);
  }
  const remote = requireRemoteName(remoteValue ?? "origin");

  const configuredMerge =
    options.remoteRef === undefined
      ? configured(
          repo,
          owner.construct("branch..merge".length + branch.length, () => `branch.${branch}.merge`),
          undefined,
          owner,
        )
      : undefined;
  const remoteRefValue = options.remoteRef ?? configuredMerge;
  if (remoteRefValue === undefined) {
    throw new GitError("ENOUPSTREAM", `branch ${branch} has no configured upstream branch`);
  }
  const remoteRef = fullBranchRef(remoteRefValue, "pull remote ref", owner);
  const remoteBranch = owner.construct(remoteRef.length - HEADS.length, () =>
    remoteRef.slice(HEADS.length),
  );

  const configuredUrl =
    options.url === undefined
      ? configured(
          repo,
          owner.construct("remote..url".length + remote.length, () => `remote.${remote}.url`),
          undefined,
          owner,
        )
      : undefined;
  const urlValue = options.url ?? configuredUrl;
  if (urlValue === undefined) throw new GitError("ENOREMOTE", `no such remote: ${remote}`);
  const resolvedUrl = pullUrl(urlValue, owner);
  const fetchShape = pullFetchShape(repo, remote, remoteRef, options, owner);

  requireMergeStrategy(repo, owner);
  const plan: PullPlan = {
    headRef,
    headOid: head.oid,
    branch,
    remote,
    ...resolvedUrl,
    remoteRef,
    remoteBranch,
    ...fetchShape,
    ...fastForwardOptions(repo, options, owner),
  };
  return plan;
}

class PullPlanOwner {
  readonly #reservation;
  #retained = 256;

  constructor(repo: Repository) {
    this.#reservation = repo.store.reserveMemory();
    this.#reservation.set("other", this.#retained);
  }

  construct<T extends string>(units: number, construct: () => T): T {
    this.#reservation.set("other", this.#retained + 48 + 2 * units);
    const value = construct();
    return this.retain(value);
  }

  retain<T extends string>(value: T): T {
    this.#retained += retainedStringBytes(value);
    this.#reservation.set("other", this.#retained);
    return value;
  }

  retainFetchResult(result: FetchResult): void {
    this.retain(result.mode);
    if (result.defaultBranch !== null) this.retain(result.defaultBranch);
    if (result.fetchHead !== null) this.retain(result.fetchHead);
    for (const update of result.updates) {
      this.retain(update.source);
      this.retain(update.destination);
      this.retain(update.oid);
    }
  }

  precharge(bytes: number): void {
    this.#reservation.set("other", this.#retained + bytes);
  }

  commitPrecharge(values: readonly string[]): void {
    this.#reservation.set("other", this.#retained);
    for (const value of values) this.retain(value);
  }

  withTransientString<T>(units: number, construct: () => string, use: (value: string) => T): T {
    this.precharge(48 + 2 * units);
    try {
      return use(construct());
    } finally {
      this.#reservation.set("other", this.#retained);
    }
  }

  get retainedBytes(): number {
    return this.#retained;
  }

  dispose(): void {
    this.#reservation.dispose();
  }
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

function defaultPullMessage(plan: PullPlan, owner: PullPlanOwner): string {
  return owner.construct(
    "Merge branch '' of ".length + plan.remoteBranch.length + plan.displayUrl.length,
    () => `Merge branch '${plan.remoteBranch}' of ${plan.displayUrl}`,
  );
}

/** Re-read post-fetch state without extending temporary allocations into merge. */
export function validatePullAfterFetch(
  repo: Repository,
  options: PullOptions,
  plan: PullPlan,
): void {
  const headOwner = new PullPlanOwner(repo);
  try {
    const head = resolveHeadOwned(repo, headOwner);
    if (head.ref !== plan.headRef || head.oid !== plan.headOid) {
      throw new GitError("ESTALEHEAD", "HEAD changed while pull was fetching its upstream");
    }
  } finally {
    headOwner.dispose();
  }

  repo.checkout.requireNoMergeState();

  const currentOwner = new PullPlanOwner(repo);
  try {
    let current: PullPlan;
    try {
      current = resolvePullOwned(repo, options, currentOwner);
    } catch (error) {
      throw new GitError(
        "ESTALEUPSTREAM",
        "upstream configuration changed while pull was fetching",
        { cause: error },
      );
    }
    if (!sameTarget(current, plan)) {
      throw new GitError(
        "ESTALEUPSTREAM",
        "upstream configuration changed while pull was fetching",
      );
    }
  } finally {
    currentOwner.dispose();
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
  const owner = new PullPlanOwner(repo);
  try {
    const plan = resolvePullOwned(repo, options, owner);
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
    owner.retainFetchResult(fetched);
    if (fetched.fetchHead === null) {
      throw new GitError("EFETCHFAIL", `remote ${plan.remote} advertised no usable upstream ref`);
    }

    validatePullAfterFetch(repo, options, plan);

    const message =
      options.message === undefined ? defaultPullMessage(plan, owner) : options.message;
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
      owner.retainedBytes,
    );
  } finally {
    owner.dispose();
  }
}
