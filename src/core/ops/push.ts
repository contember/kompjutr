// Bounded structured Smart HTTP push with one advertisement, one union pack,
// and post-status atomic tracking reconciliation.

import type { FetchPublicationToken, RefRow } from "../../sqlite/store.js";
import { isOid } from "../bytes.js";
import type { GitContext } from "../context.js";
import { CorruptError, GitError, hasErrorCode } from "../errors.js";
import { progressSink } from "../protocol/progress.js";
import {
  type ReceivePackCommand,
  type ReceivePackStatus,
  receivePack,
  requireBranchRef,
  validatePushOptions as validateReceivePushOptions,
  ZERO_OID,
} from "../protocol/receive-pack.js";
import { type Advertisement, discover } from "../protocol/remote.js";
import type { Repository } from "../repository.js";
import {
  createRemoteAuth,
  type RemoteAuthOptions,
  remoteUrlFor,
  validateRemoteAuthOptions,
} from "./network.js";
import {
  authenticatePushBranchTargets,
  disposePushPlan,
  openPushPack,
  type PushPlan,
  planPushUpdates,
} from "./push-plan.js";
import { operationRefLogMetadata } from "./ref-log.js";
import {
  type CompiledPushRefspecs,
  compilePushRefspecs,
  type ExpandedPushRefspec,
  type PushPlanningUpdate,
  type PushRefspec,
  type PushResult,
  type PushTrackingResult,
  type RefspecSourceRef,
  type RemoteTarget,
} from "./refspec.js";

interface MappedPushSelection {
  readonly refspecs: readonly [PushRefspec, ...PushRefspec[]];
  readonly ref?: never;
  readonly remoteRef?: never;
  readonly force?: never;
  readonly delete?: never;
}

interface LegacyPushSelection {
  readonly refspecs?: never;
  readonly ref?: string;
  readonly remoteRef?: string;
  readonly force?: boolean;
  readonly delete?: boolean;
}

export type PushOptions = RemoteAuthOptions &
  RemoteTarget & {
    readonly atomic?: boolean;
    readonly pushOptions?: readonly string[];
  } & (MappedPushSelection | LegacyPushSelection);

interface JoinedPushUpdate extends PushPlanningUpdate {
  readonly noop: boolean;
}

interface JoinedAdvertisement {
  readonly updates: JoinedPushUpdate[];
  readonly remoteOids: string[];
  readonly capabilities: Set<string>;
}

function emptyPushResult(): PushResult {
  return {
    ok: true,
    error: null,
    unpack: { ok: true },
    refs: [],
    tracking: { outcome: "not-applicable" },
  };
}

function validatePushOperationOptions(options: unknown): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitError("EINVAL", "push options must be an object");
  }
  validateRemoteAuthOptions(options);
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

function legacyRefspecs(
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

function localRefSnapshot(repo: Repository): RefspecSourceRef[] {
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

function needsLocalRefs(refspecs: readonly PushRefspec[]): boolean {
  for (const refspec of refspecs) {
    if (refspec.source !== null && !isOid(refspec.source)) return true;
  }
  return false;
}

function pushTarget(
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

function joinAdvertisement(
  mappings: readonly ExpandedPushRefspec[],
  advertisement: Advertisement,
): JoinedAdvertisement {
  const advertised = new Map<string, string>();
  const remoteOids: string[] = [];
  for (const ref of advertisement.refs) {
    advertised.set(ref.name, ref.oid);
    remoteOids.push(ref.oid);
  }
  const capabilities = new Set<string>();
  for (const capability of advertisement.capabilities) {
    capabilities.add(capability);
  }

  const updates: JoinedPushUpdate[] = [];
  for (const mapping of mappings) {
    const oldOid = advertised.get(mapping.destination) ?? ZERO_OID;
    const noop = mapping.oid === null ? oldOid === ZERO_OID : mapping.oid === oldOid;
    updates.push({ ...mapping, oldOid, noop });
  }
  return { updates, remoteOids, capabilities };
}

function commandSet(updates: readonly JoinedPushUpdate[]): ReceivePackCommand[] {
  const commands: ReceivePackCommand[] = [];
  for (const update of updates) {
    if (update.noop) continue;
    commands.push({
      oldOid: update.oldOid,
      newOid: update.oid ?? ZERO_OID,
      ref: update.destination,
    });
  }
  return commands;
}

function activePlanningUpdates(updates: readonly JoinedPushUpdate[]): PushPlanningUpdate[] {
  const active: PushPlanningUpdate[] = [];
  for (const update of updates) {
    if (update.noop) continue;
    active.push(update);
  }
  return active;
}

function uncertainResult(cause: unknown): GitError {
  return new GitError("EPUSHUNCERTAIN", "remote result could not be retained safely", { cause });
}

function confirmedResult(
  updates: readonly JoinedPushUpdate[],
  wire: ReceivePackStatus | null,
): Omit<PushResult, "tracking"> {
  const refs: PushResult["refs"][number][] = [];
  for (const update of updates) {
    const status = update.noop ? { ok: true } : wire?.refs.get(update.destination);
    if (status === undefined) {
      throw new CorruptError(`confirmed push result omitted ${update.destination}`);
    }
    const error = status.ok ? null : (status.error ?? "remote rejected ref");
    refs.push({ ref: update.destination, ok: status.ok, error });
  }
  const unpack: PushResult["unpack"] =
    wire === null || wire.unpack === "ok" ? { ok: true } : { ok: false, error: wire.unpack };
  const error = unpack.ok ? (refs.find((status) => !status.ok)?.error ?? null) : unpack.error;
  return { ok: error === null, error, unpack, refs };
}

function advertisedTarget(advertisement: Advertisement, name: string): string {
  return advertisement.refs.find((ref) => ref.name === name)?.oid ?? ZERO_OID;
}

function trackingName(prefix: string, destination: string): string {
  return `${prefix}${destination.slice("refs/heads/".length)}`;
}

function stableTrackingFailure(error: unknown): PushTrackingResult {
  let code = "EIO";
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = error.code;
    if (typeof value === "string" && value !== "") code = value;
  }
  const message = error instanceof Error ? error.message : "push tracking reconciliation failed";
  return { outcome: "failed", code, message };
}

async function reconcileTracking(
  context: GitContext,
  repo: Repository,
  updates: readonly JoinedPushUpdate[],
  confirmed: Omit<PushResult, "tracking">,
  url: string,
  auth: ReturnType<typeof createRemoteAuth>,
  sentCommands: boolean,
  publication: FetchPublicationToken | null,
): Promise<PushTrackingResult> {
  if (publication === null) return { outcome: "not-applicable" };
  try {
    const successful: { readonly update: JoinedPushUpdate; readonly confirmedOid: string }[] = [];
    for (let index = 0; index < updates.length; index++) {
      const update = updates[index];
      const status = confirmed.refs[index];
      if (
        update === undefined ||
        status === undefined ||
        !status.ok ||
        !update.destination.startsWith("refs/heads/")
      ) {
        continue;
      }
      const confirmedOid = update.oid ?? ZERO_OID;
      successful.push({ update, confirmedOid });
    }
    if (successful.length === 0) return { outcome: "not-applicable" };

    let rediscovered: Advertisement | null = null;
    if (sentCommands) {
      try {
        rediscovered = await discover(url, "git-receive-pack", auth);
      } catch {
        rediscovered = null;
      }
    }
    const targets: { readonly update: JoinedPushUpdate; readonly oid: string }[] = [];
    const noops: string[] = [];
    const changed: string[] = [];
    for (const item of successful) {
      const oid =
        rediscovered === null
          ? item.confirmedOid
          : advertisedTarget(rediscovered, item.update.destination);
      targets.push({ update: item.update, oid });
      if (oid !== ZERO_OID && oid !== item.confirmedOid) changed.push(oid);
      else if (oid !== ZERO_OID && item.update.noop) noops.push(oid);
    }
    if (noops.length > 0) {
      authenticatePushBranchTargets(repo, noops);
    }
    if (changed.length > 0) {
      try {
        authenticatePushBranchTargets(repo, changed);
      } catch (error) {
        if (hasErrorCode(error, "EPUSHLOCAL") || hasErrorCode(error, "EINVALIDREF")) {
          return { outcome: "deferred" };
        }
        throw error;
      }
    }

    const selected = new Set<string>();
    const puts: RefRow[] = [];
    for (const target of targets) {
      const name = trackingName(publication.trackingPrefix, target.update.destination);
      selected.add(name);
      if (target.oid !== ZERO_OID) puts.push({ name, target: target.oid });
    }
    const keep: string[] = [];
    for (const ref of publication.trackingRefs) {
      if (ref.name === `${publication.trackingPrefix}HEAD` || selected.has(ref.name)) continue;
      keep.push(ref.name);
    }
    try {
      const changedRefs = repo.store.publishFetchRefs(
        publication,
        { trackingPuts: puts, trackingKeep: keep },
        operationRefLogMetadata(context, repo, "push"),
      );
      return { outcome: changedRefs ? "updated" : "unchanged" };
    } catch (error) {
      if (hasErrorCode(error, "ESTALEFETCH")) return { outcome: "stale" };
      throw error;
    }
  } catch (error) {
    return stableTrackingFailure(error);
  }
}

/** Push one legacy branch or one bounded structured refspec set. */
export async function push(
  context: GitContext,
  repo: Repository,
  options: PushOptions,
): Promise<PushResult> {
  let compiler: CompiledPushRefspecs | null = null;
  let plan: PushPlan | null = null;
  let publication: FetchPublicationToken | null = null;
  try {
    validatePushOperationOptions(options);
    const remote = options.remote ?? "origin";
    const refspecs =
      options.refspecs === undefined ? legacyRefspecs(repo, options, remote) : options.refspecs;
    compiler = compilePushRefspecs(refspecs);
    const localRefs = needsLocalRefs(refspecs) ? localRefSnapshot(repo) : [];
    const mappings = compiler.expand(localRefs);
    localRefs.length = 0;
    if (mappings.length === 0) return emptyPushResult();

    const target = pushTarget(repo, options);
    const auth = createRemoteAuth(context, options);
    let advertisement: Advertisement | null = await discover(target.url, "git-receive-pack", auth);
    const joined = joinAdvertisement(mappings, advertisement);
    const activeUpdates = activePlanningUpdates(joined.updates);
    plan =
      activeUpdates.length === 0
        ? null
        : planPushUpdates(repo, activeUpdates, { remoteOids: joined.remoteOids });
    activeUpdates.length = 0;
    joined.remoteOids.length = 0;
    advertisement = null;
    compiler = null;

    const commands = commandSet(joined.updates);
    if (
      target.configured &&
      joined.updates.some((update) => update.destination.startsWith("refs/heads/"))
    ) {
      publication = repo.store.beginFetchPublication(`refs/remotes/${target.remote}/`, []);
    }
    let wire: ReceivePackStatus | null = null;
    if (commands.length > 0) {
      const hasNonDeletion = commands.some((command) => command.newOid !== ZERO_OID);
      if (hasNonDeletion && plan === null) {
        throw new CorruptError("non-delete push lost its pack plan");
      }
      const packPlan = plan;
      const say = progressSink(options.onProgress, options.onMessage);
      wire = await receivePack(
        {
          url: target.url,
          commands,
          advertised: joined.capabilities,
          ...(options.atomic === undefined ? {} : { atomic: options.atomic }),
          ...(options.pushOptions === undefined ? {} : { pushOptions: options.pushOptions }),
          ...(hasNonDeletion && packPlan !== null
            ? { pack: () => openPushPack(repo, packPlan) }
            : {}),
          ...(say === undefined ? {} : { onProgress: say }),
        },
        auth,
      );
    }
    if (plan !== null) {
      disposePushPlan(plan);
      plan = null;
    }

    let confirmed: Omit<PushResult, "tracking">;
    try {
      confirmed = confirmedResult(joined.updates, wire);
    } catch (cause) {
      if (commands.length > 0) throw uncertainResult(cause);
      throw cause;
    }
    const tracking = await reconcileTracking(
      context,
      repo,
      joined.updates,
      confirmed,
      target.url,
      auth,
      commands.length > 0,
      publication,
    );
    return { ...confirmed, tracking };
  } finally {
    publication?.dispose();
    if (plan !== null) disposePushPlan(plan);
  }
}
