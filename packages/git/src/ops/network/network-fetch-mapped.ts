import { CorruptError, GitError } from "../../common/errors.js";
import type { ObjectType } from "../../common/objects.js";
import type { Advertisement, uploadPack } from "../../protocol/remote.js";
import { throwIfAborted } from "../../protocol/stream.js";
import { withGitMutationGuardOwned } from "../../store/database/database.js";
import {
  type FetchPublicationPlan,
  type FetchPublicationToken,
  listCheckoutsOwned,
} from "../../store/index.js";
import type { GitContext } from "../core/context.js";
import { operationRefLogMetadata } from "../core/ref-log.js";
import { selectMergeBases } from "../merge/merge-base.js";
import type { ExpandedFetchRefspec } from "../refs/refspec.js";
import type { Repository } from "../repository/repository.js";
import { repositoryMutations } from "../repository/repository.js";
import { runFetchCheckpoint } from "./network-checkpoint.js";
import { validateFetchedConnectivity } from "./network-connectivity.js";
import {
  applyShallowResponse,
  authenticateShallowTransition,
  requestsBoundary,
  shallowMutation,
  shallowTransfer,
  wantsHeldRoots,
} from "./network-shallow.js";
import {
  advertisedTags,
  authenticateFetchedCoverage,
  authenticateTags,
  eligibleAutoTags,
} from "./network-tags.js";
import { fetchProgressSink, transferPack } from "./network-transfer.js";
import type {
  AdvertisedTag,
  FetchBehavior,
  FetchOperationOptions,
  FetchTarget,
  MappedFetchPlan,
} from "./network-types.js";

function requireMappedBranchesAvailable(
  context: GitContext,
  repo: Repository,
  refs: readonly ExpandedFetchRefspec[],
): void {
  const selected = new Set(
    refs.filter((ref) => ref.destination.startsWith("refs/heads/")).map((ref) => ref.destination),
  );
  if (selected.size === 0) return;
  for (const checkout of listCheckoutsOwned(context.database, repo.store.repoId)) {
    if (checkout.head.startsWith("ref: ") && selected.has(checkout.head.slice(5).trim())) {
      throw new GitError(
        "EBRANCHFAIL",
        `cannot fetch into checked out branch ${checkout.head.slice(5).trim()}`,
      );
    }
  }
}

function mappedExistingTargets(token: FetchPublicationToken): ReadonlyMap<string, string | null> {
  const targets = new Map<string, string | null>();
  for (const ref of token.exactRefs) {
    targets.set(ref.name, ref.target);
  }
  return targets;
}

function preflightMappedUpdates(
  refs: readonly ExpandedFetchRefspec[],
  token: FetchPublicationToken,
): void {
  const existing = mappedExistingTargets(token);
  for (const ref of refs) {
    if (ref.destination.startsWith(token.trackingPrefix)) continue;
    const previous = existing.get(ref.destination);
    if (previous === undefined) {
      throw new CorruptError(`fetch publication omitted candidate ${ref.destination}`);
    }
    if (
      ref.destination.startsWith("refs/tags/") &&
      previous !== null &&
      previous !== ref.oid &&
      !ref.force
    ) {
      throw new GitError("ETAGFAIL", `fetch would clobber existing tag ${ref.destination}`);
    }
  }
}

function requireMappedUpdateRules(
  repo: Repository,
  refs: readonly ExpandedFetchRefspec[],
  token: FetchPublicationToken,
  types: ReadonlyMap<string, ObjectType>,
): void {
  const existing = mappedExistingTargets(token);
  for (const ref of refs) {
    const type = types.get(ref.oid);
    if (type === undefined) {
      throw new GitError("EFETCHFAIL", `fetch did not authenticate ${ref.source}`);
    }
    if (ref.destination.startsWith("refs/heads/") && type !== "commit") {
      throw new GitError("EINVALIDREF", `branch destination ${ref.destination} requires a commit`);
    }
    const previous = existing.get(ref.destination);
    if (
      ref.destination.startsWith("refs/heads/") &&
      previous !== undefined &&
      previous !== null &&
      previous !== ref.oid &&
      !ref.force
    ) {
      const selection = selectMergeBases(repo, {
        currentOid: previous,
        incomingOid: ref.oid,
      });
      if (selection.kind !== "fast-forward") {
        throw new GitError("ENONFASTFORWARD", `fetch would not fast-forward ${ref.destination}`);
      }
    }
  }
}

function remoteHeadTarget(
  plan: MappedFetchPlan,
  token: FetchPublicationToken,
): string | null | undefined {
  if (plan.remoteHead === undefined) return undefined;
  const tracking = plan.remoteHead;
  if (tracking !== null) {
    const kept = plan.trackingKeep === undefined || plan.trackingKeep.includes(tracking);
    const retained = kept && token.trackingRefs.some((ref) => ref.name === tracking);
    if (retained || plan.updates.some((update) => update.destination === tracking)) {
      return `ref: ${tracking}`;
    }
  }
  return plan.trackingKeep === undefined ? undefined : null;
}

/**
 * The one fetch engine: fence the destinations, transfer one validated pack,
 * follow tags, authenticate every selected object and the shallow transition,
 * then publish all refs and the boundary in one transaction.
 */
export async function fetchMappedInto(
  context: GitContext,
  repo: Repository,
  options: FetchOperationOptions,
  behavior: FetchBehavior,
  refLogReason: "fetch" | "clone: fetch",
  target: FetchTarget,
  advertisement: Advertisement,
  auth: NonNullable<Parameters<typeof uploadPack>[1]>,
  plan: MappedFetchPlan,
): Promise<void> {
  requireMappedBranchesAvailable(context, repo, plan.updates);
  const tags = advertisedTags(advertisement);
  const trackingPrefix = `refs/remotes/${target.remote}/`;
  const tracking = plan.updates.filter((ref) => ref.destination.startsWith(trackingPrefix));
  const exact = plan.updates.filter((ref) => !ref.destination.startsWith(trackingPrefix));
  const destinations = new Set(plan.updates.map((ref) => ref.destination));
  const followable = plan.followTags ? tags.filter((tag) => !destinations.has(tag.ref.name)) : [];
  // The issued snapshot already holds the tracking namespace; only other destinations are candidates.
  const publication = repo.store.beginFetchPublication(trackingPrefix, [
    ...exact.map((ref) => ref.destination),
    ...followable.map((tag) => tag.ref.name),
  ]);
  try {
    preflightMappedUpdates(plan.updates, publication);
    await runFetchCheckpoint(behavior.checkpoint, "after-discovery", options.signal);

    const rootNames = new Set(plan.roots.map((ref) => ref.name));
    const selectedTags = tags.filter((tag) => rootNames.has(tag.ref.name));
    const boundary = new Set(publication.shallow);
    const followed = await transferFetchObjects(context, repo, {
      options,
      behavior,
      target,
      advertisement,
      auth,
      plan,
      publication,
      selectedTags,
      followable,
      boundary,
    });

    const publishedTags = [...selectedTags, ...followed];
    authenticateTags(repo, publishedTags);
    const candidates = [
      ...plan.roots.map((ref) => ref.oid),
      ...publishedTags.map((tag) => tag.peeledOid),
    ];
    const types = authenticateFetchedCoverage(repo, plan.roots, candidates);
    requireMappedUpdateRules(repo, plan.updates, publication, types);
    const boundaryChanged =
      boundary.size !== publication.shallow.length ||
      publication.shallow.some((oid) => !boundary.has(oid));
    if (requestsBoundary(plan.shallow) || boundaryChanged) {
      const commitRoots = candidates.filter((oid) => types.get(oid) === "commit");
      authenticateShallowTransition(repo, publication.shallow, boundary, commitRoots);
    }
    const shallow = shallowMutation(publication.shallow, boundary);
    const remoteHead = remoteHeadTarget(plan, publication);
    const publicationPlan: FetchPublicationPlan = {
      trackingPuts: tracking.map((ref) => ({ name: ref.destination, target: ref.oid })),
      exactPuts: [
        ...exact.map((ref) => ({ name: ref.destination, target: ref.oid })),
        ...followed.map((tag) => ({ name: tag.ref.name, target: tag.ref.oid })),
      ],
      ...(plan.trackingKeep === undefined ? {} : { trackingKeep: plan.trackingKeep }),
      ...(remoteHead === undefined ? {} : { remoteHead }),
      shallowAdd: shallow.add,
      shallowRemove: shallow.remove,
    };
    const roots = [...plan.roots.map((ref) => ref.oid), ...followed.map((tag) => tag.ref.oid)];

    await runFetchCheckpoint(behavior.checkpoint, "before-ref-publication", options.signal);
    throwIfAborted(options.signal);
    withGitMutationGuardOwned(context.database, () => {
      const finalBoundary = repo.shallow();
      for (const oid of shallow.remove) finalBoundary.delete(oid);
      for (const oid of shallow.add) finalBoundary.add(oid);
      validateFetchedConnectivity(repo, roots, finalBoundary);
      repositoryMutations(repo).publishFetchRefsOwned(
        publication,
        publicationPlan,
        operationRefLogMetadata(context, repo, refLogReason),
      );
      publication.dispose();
    });
    const afterRefs = behavior.checkpoint?.("after-ref-publication");
    if (afterRefs !== undefined) await afterRefs;
  } finally {
    publication.dispose();
  }
}

interface FetchTransfer {
  readonly options: FetchOperationOptions;
  readonly behavior: FetchBehavior;
  readonly target: FetchTarget;
  readonly advertisement: Advertisement;
  readonly auth: NonNullable<Parameters<typeof uploadPack>[1]>;
  readonly plan: MappedFetchPlan;
  readonly publication: FetchPublicationToken;
  readonly selectedTags: readonly AdvertisedTag[];
  readonly followable: readonly AdvertisedTag[];
  /** The proposed boundary; every shallow response is applied to it. */
  readonly boundary: Set<string>;
}

/** Transfer the selected objects, then return the tags auto-follow completed. */
async function transferFetchObjects(
  context: GitContext,
  repo: Repository,
  transfer: FetchTransfer,
): Promise<AdvertisedTag[]> {
  const { options, behavior, target, plan, publication, followable, boundary } = transfer;
  const say = fetchProgressSink(options.onProgress, options.onMessage);
  const filter =
    options.filter === undefined ? {} : { filter: options.filter, promisorRemote: target.remote };
  const initialFollow =
    followable.length > 0 ? eligibleAutoTags(repo, followable, publication) : [];
  const wanted = [
    ...plan.roots.map((ref) => ref.oid),
    ...initialFollow.map((tag) => tag.ref.oid),
    ...transfer.selectedTags.map((tag) => tag.peeledOid),
  ];
  const wants = wantsHeldRoots(plan.shallow, plan.roots, publication.shallow)
    ? [...new Set(wanted)]
    : repo.store.missing(wanted);
  applyShallowResponse(
    boundary,
    await transferPack(
      context,
      repo,
      {
        url: target.url,
        wants,
        shallows: [...publication.shallow],
        advertised: transfer.advertisement.capabilities,
        ...shallowTransfer(plan.shallow),
        ...(plan.followTags ? { includeTag: true } : {}),
        ...filter,
      },
      transfer.auth,
      say,
      behavior.checkpoint,
    ),
  );
  if (followable.length === 0) return [];

  // A server without include-tag may omit annotated tag objects. Once their
  // peeled targets are local, one bounded fallback request completes them.
  const eligible = eligibleAutoTags(repo, followable, publication);
  const fallbackWants = repo.store.missing(eligible.map((tag) => tag.ref.oid));
  const missing = new Set(fallbackWants);
  applyShallowResponse(
    boundary,
    await transferPack(
      context,
      repo,
      {
        url: target.url,
        wants: fallbackWants,
        shallows: [...boundary],
        advertised: transfer.advertisement.capabilities,
        haves: eligible.filter((tag) => missing.has(tag.ref.oid)).map((tag) => tag.peeledOid),
        ...filter,
      },
      transfer.auth,
      say,
      behavior.checkpoint,
    ),
  );
  return eligibleAutoTags(repo, followable, publication);
}
