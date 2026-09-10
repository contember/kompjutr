import type { Advertisement, uploadPack } from "../../protocol/remote.js";
import { throwIfAborted } from "../../protocol/stream.js";
import { withGitMutationGuardOwned } from "../../store/database/database.js";
import type { FetchPublicationPlan } from "../../store/index.js";
import { sharedRepoStoreMutations } from "../../store/repository/shared.js";
import type { GitContext } from "../core/context.js";
import { operationRefLogMetadata } from "../core/ref-log.js";
import type { Repository } from "../repository/repository.js";
import { runFetchCheckpoint } from "./network-checkpoint.js";
import { validateFetchedConnectivity } from "./network-connectivity.js";
import { selectRefs } from "./network-selection.js";
import {
  applyShallowResponse,
  authenticateShallowTransition,
  shallowMutation,
} from "./network-shallow.js";
import {
  advertisedTags,
  authenticateFetchedCoverage,
  authenticateTags,
  eligibleAutoTags,
  preflightAllTags,
} from "./network-tags.js";
import { fetchProgressSink, transferPack } from "./network-transfer.js";
import type {
  FetchBehavior,
  FetchOperationOptions,
  FetchResult,
  FetchTarget,
  LegacyFetchResult,
  LegacyFetchSelection,
  PreparedLegacyFetchPublication,
} from "./network-types.js";

const PROTOCOL_UNSHALLOW_DEPTH = 0x7fffffff;

async function prepareLegacyFetchPublication(
  context: GitContext,
  repo: Repository,
  options: FetchOperationOptions & LegacyFetchSelection,
  behavior: FetchBehavior,
  target: FetchTarget,
  advertisement: Advertisement,
  auth: NonNullable<Parameters<typeof uploadPack>[1]>,
): Promise<PreparedLegacyFetchPublication> {
  const { remote, url } = target;
  const defaultBranch = advertisement.headRef;
  const requestedRef = options.remoteRef ?? options.ref;
  const coverageRef = behavior.coverageRef ?? requestedRef;
  const selection = selectRefs(advertisement, {
    ...(coverageRef === undefined ? {} : { coverageRef }),
    ...(behavior.resultRef === undefined
      ? requestedRef === undefined
        ? {}
        : { resultRef: requestedRef }
      : { resultRef: behavior.resultRef }),
    singleBranch: options.singleBranch ?? false,
  });
  const fetchHead = selection.result?.oid ?? null;
  const autoTags = options.tags === undefined && (behavior.autoTags ?? requestedRef === undefined);
  const allTags = options.tags === true;
  const tags = advertisedTags(advertisement);
  const selectedTagNames = new Set(
    selection.coverage.filter((ref) => ref.name.startsWith("refs/tags/")).map((ref) => ref.name),
  );
  const requiredTags = tags.filter((tag) => allTags || selectedTagNames.has(tag.ref.name));
  const candidateTags = allTags || autoTags ? tags : requiredTags;
  const trackingPrefix = `refs/remotes/${remote}/`;
  const publication = repo.store.beginFetchPublication(
    trackingPrefix,
    candidateTags.map((tag) => tag.ref.name),
  );

  try {
    preflightAllTags(publication, requiredTags);
    await runFetchCheckpoint(behavior.checkpoint, "after-discovery", options.signal);

    const say = fetchProgressSink(options.onProgress, options.onMessage);
    const initialAutoTags =
      autoTags && tags.length > 0 ? eligibleAutoTags(repo, tags, publication) : [];
    const transferRefs = [
      ...selection.coverage,
      ...(allTags ? tags.map((tag) => tag.ref) : initialAutoTags.map((tag) => tag.ref)),
    ];
    const requiredTagTargets = requiredTags.map((tag) => tag.peeledOid);
    const wantedOids = [...transferRefs.map((ref) => ref.oid), ...requiredTagTargets];
    const advertisedHeads = selection.coverage.filter((ref) => ref.name.startsWith("refs/heads/"));
    const publishedShallow = new Set(publication.shallow);
    const depthOneAlreadyPublished =
      options.depth === 1 &&
      advertisedHeads.length > 0 &&
      advertisedHeads.every((ref) => publishedShallow.has(ref.oid));
    // An unproven depth request must renegotiate shallow boundaries even when a prior
    // failed publication already left the advertised tip object complete.
    const forceBoundaryNegotiation = options.deepen !== undefined || options.unshallow === true;
    const wants =
      forceBoundaryNegotiation ||
      (options.depth !== undefined && options.depth > 0 && !depthOneAlreadyPublished)
        ? [...new Set(wantedOids)]
        : repo.store.missing(wantedOids);
    const shallows = [...publication.shallow];
    const proposedShallow = new Set(publication.shallow);
    const transferDepth =
      options.deepen ?? (options.unshallow === true ? PROTOCOL_UNSHALLOW_DEPTH : options.depth);
    applyShallowResponse(
      proposedShallow,
      await transferPack(
        context,
        repo,
        {
          url,
          wants,
          shallows,
          advertised: advertisement.capabilities,
          ...(transferDepth === undefined ? {} : { depth: transferDepth }),
          ...(options.deepen === undefined ? {} : { deepenRelative: true }),
          ...(autoTags ? { includeTag: true } : {}),
          ...(options.filter === undefined ? {} : { filter: options.filter }),
          ...(options.filter === undefined ? {} : { promisorRemote: remote }),
        },
        auth,
        say,
        behavior.checkpoint,
      ),
    );

    // A server without include-tag may omit annotated tag objects. Once their
    // peeled targets are local, one bounded fallback request completes them.
    if (autoTags && tags.length > 0) {
      const eligible = eligibleAutoTags(repo, tags, publication);
      const fallbackWants = repo.store.missing(eligible.map((tag) => tag.ref.oid));
      const wanted = new Set(fallbackWants);
      applyShallowResponse(
        proposedShallow,
        await transferPack(
          context,
          repo,
          {
            url,
            wants: fallbackWants,
            shallows: [...proposedShallow],
            advertised: advertisement.capabilities,
            haves: eligible.filter((tag) => wanted.has(tag.ref.oid)).map((tag) => tag.peeledOid),
            ...(options.filter === undefined ? {} : { filter: options.filter }),
            ...(options.filter === undefined ? {} : { promisorRemote: remote }),
          },
          auth,
          say,
          behavior.checkpoint,
        ),
      );
    }

    const finalAutoTags =
      autoTags && tags.length > 0 ? eligibleAutoTags(repo, tags, publication) : [];
    const selectedTags = allTags ? tags : autoTags ? finalAutoTags : requiredTags;
    authenticateTags(repo, selectedTags);
    const boundaryRequested =
      (options.depth !== undefined && options.depth > 0) || forceBoundaryNegotiation;
    const boundaryChanged =
      proposedShallow.size !== publication.shallow.length ||
      publication.shallow.some((oid) => !proposedShallow.has(oid));
    const candidates = [
      ...selection.coverage.map((ref) => ref.oid),
      ...selectedTags.map((tag) => tag.peeledOid),
    ];
    const types = authenticateFetchedCoverage(repo, selection.coverage, candidates);
    if (boundaryRequested || boundaryChanged) {
      const commitRoots = candidates.filter((oid) => types.get(oid) === "commit");
      authenticateShallowTransition(repo, publication.shallow, proposedShallow, commitRoots);
    }
    const shallow = shallowMutation(publication.shallow, proposedShallow);
    // Only the configured remote owns its tracking namespace; an explicit URL publishes
    // FETCH_HEAD and tags alone, as an explicit push URL reconciles nothing.
    const trackingPuts = target.configured
      ? selection.coverage
          .filter((ref) => ref.name.startsWith("refs/heads/"))
          .map((ref) => ({
            name: `${trackingPrefix}${ref.name.slice("refs/heads/".length)}`,
            target: ref.oid,
          }))
      : [];
    const trackingKeep =
      target.configured && options.prune === true
        ? advertisement.refs
            .filter((ref) => ref.name.startsWith("refs/heads/"))
            .map((ref) => `${trackingPrefix}${ref.name.slice("refs/heads/".length)}`)
        : undefined;
    const retainedTracking = new Set(publication.trackingRefs.map((ref) => ref.name));
    const keptTracking = new Set(trackingKeep ?? retainedTracking);
    const updatedTracking = new Set(trackingPuts.map((ref) => ref.name));
    let remoteHead: string | null | undefined;
    if (target.configured) {
      const headRef = advertisement.headRef ?? "";
      if (headRef.startsWith("refs/heads/")) {
        const tracking = `${trackingPrefix}${headRef.slice("refs/heads/".length)}`;
        const retained =
          retainedTracking.has(tracking) &&
          (trackingKeep === undefined || keptTracking.has(tracking));
        if (updatedTracking.has(tracking) || retained) {
          remoteHead = `ref: ${tracking}`;
        } else if (options.prune === true) {
          remoteHead = null;
        }
      } else if (options.prune === true) {
        remoteHead = null;
      }
    }
    await runFetchCheckpoint(behavior.checkpoint, "before-ref-publication", options.signal);
    const updates: [] = [];
    const result: LegacyFetchResult = {
      mode: "legacy",
      defaultBranch,
      fetchHead,
      updates,
    };
    const plan: FetchPublicationPlan = {
      trackingPuts,
      ...(trackingKeep === undefined ? {} : { trackingKeep }),
      ...(remoteHead === undefined ? {} : { remoteHead }),
      globalTagPuts: selectedTags.map((tag) => ({
        name: tag.ref.name,
        target: tag.ref.oid,
      })),
      shallowAdd: shallow.add,
      shallowRemove: shallow.remove,
    };
    return {
      publication,
      plan,
      result,
      roots: [
        ...selection.coverage.map((ref) => ref.oid),
        ...selectedTags.map((tag) => tag.ref.oid),
      ],
    };
  } catch (error) {
    publication.dispose();
    throw error;
  }
}

export async function fetchLegacyInto(
  context: GitContext,
  repo: Repository,
  options: FetchOperationOptions & LegacyFetchSelection,
  behavior: FetchBehavior,
  refLogReason: "fetch" | "clone: fetch",
  target: FetchTarget,
  advertisement: Advertisement,
  auth: NonNullable<Parameters<typeof uploadPack>[1]>,
): Promise<FetchResult> {
  const prepared = await prepareLegacyFetchPublication(
    context,
    repo,
    options,
    behavior,
    target,
    advertisement,
    auth,
  );
  let plan = prepared.plan;
  try {
    if (plan === null) throw new Error("legacy fetch lost its publication plan");
    throwIfAborted(options.signal);
    const publicationPlan = plan;
    withGitMutationGuardOwned(context.database, () => {
      const boundary = repo.shallow();
      for (const oid of publicationPlan.shallowRemove ?? []) boundary.delete(oid);
      for (const oid of publicationPlan.shallowAdd ?? []) boundary.add(oid);
      validateFetchedConnectivity(repo, prepared.roots, boundary);
      sharedRepoStoreMutations(repo.store).publishFetchRefsOwned(
        prepared.publication,
        publicationPlan,
        operationRefLogMetadata(context, repo, refLogReason),
      );
      prepared.publication.dispose();
      plan = null;
      prepared.plan = null;
    });
    const afterRefs = behavior.checkpoint?.("after-ref-publication");
    if (afterRefs !== undefined) await afterRefs;
    return prepared.result;
  } finally {
    prepared.publication.dispose();
    plan = null;
    prepared.plan = null;
  }
}
