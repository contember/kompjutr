// Bounded structured Smart HTTP push with one advertisement, one union pack,
// and post-status atomic tracking reconciliation.

import { CorruptError } from "../common/errors.js";
import { progressSink } from "../protocol/progress.js";
import { type ReceivePackStatus, receivePack, ZERO_OID } from "../protocol/receive-pack.js";
import { type Advertisement, discover } from "../protocol/remote.js";
import { throwIfAborted } from "../protocol/stream.js";
import type { FetchPublicationToken } from "../store/index.js";
import type { GitContext } from "./context.js";
import { createRemoteAuth, withPromisorHydration } from "./network.js";
import {
  activePlanningUpdates,
  commandSet,
  confirmedResult,
  emptyPushResult,
  joinAdvertisement,
  uncertainResult,
  verifyPushLeases,
} from "./push-negotiation.js";
import {
  legacyRefspecs,
  localRefSnapshot,
  needsLocalRefs,
  pushTarget,
  snapshotPushLeases,
  validatePushOperationOptions,
} from "./push-options.js";
import { disposePushPlan, openPushPack, type PushPlan, planPushUpdates } from "./push-plan.js";
import { reconcileTracking } from "./push-tracking.js";
import type { PushOptions } from "./push-types.js";
import {
  type CompiledPushRefspecs,
  compilePushRefspecs,
  normalizePushLeases,
  type PushResult,
} from "./refspec.js";
import type { Repository } from "./repository.js";

async function* pushPackBody(
  repo: Repository,
  plan: PushPlan,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  throwIfAborted(signal);
  for await (const chunk of openPushPack(repo, plan)) {
    throwIfAborted(signal);
    yield chunk;
  }
  throwIfAborted(signal);
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
    throwIfAborted(options.signal);
    const remote = options.remote ?? "origin";
    const refspecs =
      options.refspecs === undefined ? legacyRefspecs(repo, options, remote) : options.refspecs;
    compiler = compilePushRefspecs(refspecs);
    const localRefs = needsLocalRefs(refspecs) ? localRefSnapshot(repo) : [];
    const mappings = compiler.expand(localRefs);
    localRefs.length = 0;
    const leases = normalizePushLeases(options.leases, mappings);
    if (mappings.length === 0) return emptyPushResult();

    const target = pushTarget(repo, options);
    const leaseSnapshot = snapshotPushLeases(repo, leases, target);
    const auth = createRemoteAuth(context, options, options.signal);
    let advertisement: Advertisement | null = await discover(target.url, "git-receive-pack", auth);
    throwIfAborted(options.signal);
    const joined = joinAdvertisement(mappings, advertisement);
    verifyPushLeases(joined.updates, leaseSnapshot);
    const activeUpdates = activePlanningUpdates(joined.updates);
    if (activeUpdates.length === 0) {
      plan = null;
    } else {
      plan = await withPromisorHydration(
        context,
        repo,
        () => {
          throwIfAborted(options.signal);
          const planned = planPushUpdates(repo, activeUpdates, {
            remoteOids: joined.remoteOids,
          });
          throwIfAborted(options.signal);
          return planned;
        },
        { signal: options.signal },
      );
    }
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
            ? { pack: () => pushPackBody(repo, packPlan, options.signal) }
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
      options.signal,
    );
    return { ...confirmed, tracking };
  } finally {
    publication?.dispose();
    if (plan !== null) disposePushPlan(plan);
  }
}

export type { PushOptions } from "./push-types.js";
