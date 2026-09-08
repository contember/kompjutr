import { hasErrorCode } from "../../common/errors.js";
import { ZERO_OID } from "../../protocol/receive-pack.js";
import { type Advertisement, discover } from "../../protocol/remote.js";
import { throwIfAborted } from "../../protocol/stream.js";
import { withGitMutationGuardOwned } from "../../store/database/database.js";
import type { FetchPublicationToken, RefRow } from "../../store/index.js";
import { sharedRepoStoreMutations } from "../../store/repository/shared.js";
import type { GitContext } from "../core/context.js";
import { operationRefLogMetadata } from "../core/ref-log.js";
import type { createRemoteAuth } from "../network/network.js";
import type { PushResult, PushTrackingResult } from "../refs/refspec.js";
import type { Repository } from "../repository/repository.js";
import { trackingName } from "./push-options.js";
import { authenticatePushBranchTargets } from "./push-plan.js";
import type { JoinedPushUpdate } from "./push-types.js";

function advertisedTarget(advertisement: Advertisement, name: string): string {
  return advertisement.refs.find((ref) => ref.name === name)?.oid ?? ZERO_OID;
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

export async function reconcileTracking(
  context: GitContext,
  repo: Repository,
  updates: readonly JoinedPushUpdate[],
  confirmed: Omit<PushResult, "tracking">,
  url: string,
  auth: ReturnType<typeof createRemoteAuth>,
  sentCommands: boolean,
  publication: FetchPublicationToken | null,
  signal: AbortSignal | undefined,
): Promise<PushTrackingResult> {
  if (publication === null) return { outcome: "not-applicable" };
  try {
    throwIfAborted(signal);
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
      } catch (error) {
        if (hasErrorCode(error, "EABORTED")) throw error;
        rediscovered = null;
      }
    }
    throwIfAborted(signal);
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
      throwIfAborted(signal);
      authenticatePushBranchTargets(repo, noops);
    }
    if (changed.length > 0) {
      throwIfAborted(signal);
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
    throwIfAborted(signal);
    try {
      const changedRefs = withGitMutationGuardOwned(context.database, () =>
        sharedRepoStoreMutations(repo.store).publishFetchRefsOwned(
          publication,
          { trackingPuts: puts, trackingKeep: keep },
          operationRefLogMetadata(context, repo, "push"),
        ),
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
