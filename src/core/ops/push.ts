// One-branch Smart HTTP push. The remote ref moves only after receive-pack
// validates the complete pack and compares the advertised old oid.

import type { GitContext } from "../context.js";
import { CorruptError, GitError, hasErrorCode } from "../errors.js";
import { progressSink } from "../protocol/progress.js";
import {
  type ReceivePackStatus,
  receivePack,
  requireBranchRef,
  ZERO_OID,
} from "../protocol/receive-pack.js";
import { discover } from "../protocol/remote.js";
import { RemoteAuthSession } from "../protocol/transport.js";
import type { Repository } from "../repository.js";
import type { PushResult, RefUpdateStatus } from "./kinds.js";
import { type RemoteAuthOptions, remoteUrlFor } from "./network.js";
import { openPushPack, planPushObjects } from "./push-plan.js";

export interface PushOptions extends RemoteAuthOptions {
  remote?: string;
  url?: string;
  ref?: string;
  remoteRef?: string;
  force?: boolean;
  delete?: boolean;
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

function pushUrlFor(repo: Repository, remote: string, explicit: string | undefined): string {
  const url =
    explicit ?? repo.store.configGet(`remote.${remote}.pushurl`) ?? remoteUrlFor(repo, remote);
  if (url === undefined) throw new GitError("ENOREMOTE", `no such remote: ${remote}`);
  return url;
}

function resultFor(
  ref: string,
  status: RefUpdateStatus,
  unpackError: string | null = null,
): PushResult {
  const error = unpackError ?? status.error ?? null;
  return { ok: error === null && status.ok, error, refs: { [ref]: status } };
}

function trackingRef(remote: string, remoteRef: string): string {
  return `refs/remotes/${remote}/${remoteRef.slice("refs/heads/".length)}`;
}

function updateTracking(
  repo: Repository,
  remote: string,
  remoteRef: string,
  newOid: string,
  deleting: boolean,
): void {
  const tracking = trackingRef(remote, remoteRef);
  repo.store.updateRefs(
    deleting ? [] : [{ name: tracking, target: newOid }],
    deleting ? [tracking] : [],
  );
}

export async function push(
  context: GitContext,
  repo: Repository,
  options: PushOptions,
): Promise<PushResult> {
  const remote = options.remote ?? "origin";
  const localRef =
    options.delete === true && options.ref === undefined && options.remoteRef !== undefined
      ? fullBranchRef(options.remoteRef)
      : localBranch(repo, options.ref);
  const remoteRef = targetBranch(repo, localRef, remote, options.remoteRef);
  const url = pushUrlFor(repo, remote, options.url);
  const newOid = options.delete === true ? ZERO_OID : repo.resolveRef(localRef);
  if (newOid === null) throw new GitError("EREFNOTFOUND", `couldn't find local ref ${localRef}`);
  if (newOid !== ZERO_OID && repo.typeOf(newOid) !== "commit") {
    throw new GitError("EINVALIDREF", `${localRef} does not point to a commit`);
  }

  const authSession = new RemoteAuthSession();
  const auth = {
    ...(context.http === undefined ? {} : { http: context.http }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.onAuth === undefined ? {} : { onAuth: options.onAuth }),
    authSession,
  };
  const advertisement = await discover(url, "git-receive-pack", auth);
  const advertised = advertisement.refs.filter((ref) => ref.name === remoteRef);
  if (advertised.length > 1)
    throw new CorruptError(`remote advertised ${remoteRef} more than once`);
  const oldOid = advertised[0]?.oid ?? ZERO_OID;
  if (!/^[0-9a-f]{40}$/.test(oldOid)) {
    throw new CorruptError(`remote advertised an invalid oid for ${remoteRef}`);
  }

  const deleting = options.delete === true;
  if ((!deleting && oldOid === newOid) || (deleting && oldOid === ZERO_OID)) {
    if (options.url === undefined) updateTracking(repo, remote, remoteRef, newOid, deleting);
    return resultFor(remoteRef, { ok: true });
  }

  const plan = deleting
    ? undefined
    : planPushObjects(
        repo,
        newOid,
        oldOid,
        options.force === true,
        advertisement.refs.map((ref) => ref.oid),
      );
  const say = progressSink(options.onProgress, options.onMessage);
  let status: ReceivePackStatus;
  try {
    status = await receivePack(
      {
        url,
        oldOid,
        newOid,
        ref: remoteRef,
        advertised: advertisement.capabilities,
        ...(plan === undefined ? {} : { pack: () => openPushPack(repo, plan) }),
        ...(say === undefined ? {} : { onProgress: say }),
      },
      auth,
    );
  } catch (error) {
    if (
      hasErrorCode(error, "EHTTP") ||
      hasErrorCode(error, "EUNSUPPORTED") ||
      hasErrorCode(error, "EPUSHREJECTED") ||
      hasErrorCode(error, "EPUSHLOCAL")
    ) {
      throw error;
    }
    throw new GitError(
      "EPUSHUNCERTAIN",
      `remote may have updated ${remoteRef}; discover or fetch before retrying`,
      { cause: error },
    );
  }
  const refStatus = status.refs.get(remoteRef)!;
  const unpackError = status.unpack === "ok" ? null : `unpack ${status.unpack}`;
  const result = resultFor(remoteRef, refStatus, unpackError);
  if (!result.ok) {
    throw new GitError("EPUSHREJECTED", result.error ?? `remote rejected ${remoteRef}`);
  }
  if (options.url === undefined) updateTracking(repo, remote, remoteRef, newOid, deleting);
  return result;
}
