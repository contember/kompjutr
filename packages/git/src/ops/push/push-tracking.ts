import { GitError, hasErrorCode } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import { ZERO_OID } from "../../protocol/receive-pack.js";
import { withGitMutationGuardOwned } from "../../store/database/database.js";
import type { FetchPublicationToken, RefRow } from "../../store/index.js";
import { sharedRepoStoreMutations } from "../../store/repository/shared.js";
import type { GitContext } from "../core/context.js";
import { operationRefLogMetadata } from "../core/ref-log.js";
import type { PushResult, PushTrackingResult } from "../refs/refspec.js";
import type { Repository } from "../repository/repository.js";
import { trackingName } from "./push-options.js";
import type { JoinedPushUpdate } from "./push-types.js";

function stableTrackingFailure(error: unknown): PushTrackingResult {
  let code = "EIO";
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = error.code;
    if (typeof value === "string" && value !== "") code = value;
  }
  const message = error instanceof Error ? error.message : "push tracking reconciliation failed";
  return { outcome: "failed", code, message };
}

// A no-op sends no pack, so nothing proved its source is a local commit.
function requireNoopCommitTargets(
  repo: Repository,
  targets: readonly { readonly update: JoinedPushUpdate; readonly oid: string }[],
): void {
  if (targets.length === 0) return;
  let types: ReadonlyMap<string, ObjectType>;
  try {
    types = new Map(
      repo.store
        .objectInfo(targets.map((target) => target.oid))
        .map((info) => [info.oid, info.type]),
    );
  } catch (cause) {
    throw new GitError("EPUSHLOCAL", "local push source or closure is incomplete", { cause });
  }
  for (const target of targets) {
    if (types.get(target.oid) !== "commit") {
      throw new GitError("EINVALIDREF", `push branch target ${target.oid} is not a direct commit`);
    }
  }
}

export function reconcileTracking(
  context: GitContext,
  repo: Repository,
  updates: readonly JoinedPushUpdate[],
  confirmed: Omit<PushResult, "tracking">,
  publication: FetchPublicationToken | null,
): PushTrackingResult {
  if (publication === null) return { outcome: "not-applicable" };
  try {
    const targets: { readonly update: JoinedPushUpdate; readonly oid: string }[] = [];
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
      targets.push({ update, oid: update.oid ?? ZERO_OID });
    }
    if (targets.length === 0) return { outcome: "not-applicable" };
    requireNoopCommitTargets(
      repo,
      targets.filter((target) => target.update.noop && target.oid !== ZERO_OID),
    );

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
