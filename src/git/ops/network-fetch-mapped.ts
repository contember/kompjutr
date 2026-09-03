import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import {
  hashObject,
  type ObjectType,
  parseCommit,
  parseTree,
  type RawObject,
} from "../common/objects.js";
import type { Advertisement, uploadPack } from "../protocol/remote.js";
import { throwIfAborted } from "../protocol/stream.js";
import { withGitMutationGuardOwned } from "../store/database.js";
import {
  type FetchPublicationToken,
  listCheckoutsOwned,
  PACK_BLOB_BATCH_TARGET_BYTES,
} from "../store/index.js";
import type { GitContext } from "./context.js";
import { selectMergeBases } from "./merge-base.js";
import { runFetchCheckpoint } from "./network-checkpoint.js";
import { advertisedTags, authenticateTags, parseAuthenticatedTag } from "./network-tags.js";
import { fetchProgressSink, transferPack } from "./network-transfer.js";
import type {
  AdvertisedTag,
  FetchBehavior,
  FetchOperationOptions,
  FetchResult,
  MappedFetchSelection,
} from "./network-types.js";
import { operationRefLogMetadata } from "./ref-log.js";
import type { ExpandedFetchRefspec } from "./refspec.js";
import type { Repository } from "./repository.js";
import { repositoryMutations } from "./repository.js";

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

function mappedTagTargets(
  advertisement: Advertisement,
  refs: readonly ExpandedFetchRefspec[],
): AdvertisedTag[] {
  const selected = new Set(
    refs.filter((ref) => ref.source.startsWith("refs/tags/")).map((ref) => ref.source),
  );
  return advertisedTags(advertisement).filter((tag) => selected.has(tag.ref.name));
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

function validateMappedObject(oid: string, object: RawObject): void {
  if (hashObject(object.type, object.data) !== oid) {
    throw new CorruptError(`fetched object ${oid} does not match its bytes`);
  }
  if (object.type === "commit") parseCommit(object.data);
  else if (object.type === "tree") parseTree(object.data);
  else if (object.type === "tag") parseAuthenticatedTag(oid, object.data);
}

function authenticateMappedRoots(
  repo: Repository,
  refs: readonly ExpandedFetchRefspec[],
): ReadonlyMap<string, ObjectType> {
  const types = new Map<string, ObjectType>();
  const rememberType = (oid: string, type: ObjectType): void => {
    types.set(oid, type);
  };
  let remaining = [...new Set(refs.map((ref) => ref.oid))];
  while (remaining.length > 0) {
    let info: ReturnType<Repository["store"]["objectInfo"]>;
    try {
      info = repo.store.objectInfo(remaining);
    } catch (error) {
      if (hasErrorCode(error, "ENOTFOUND")) {
        throw new GitError("EFETCHFAIL", "fetch did not receive every selected object", {
          cause: error,
        });
      }
      throw error;
    }
    let selected = 0;
    let selectedBytes = 0;
    while (selected < info.length) {
      const object = info[selected];
      const oid = remaining[selected];
      if (object === undefined || oid === undefined || object.oid !== oid) {
        throw new CorruptError("fetch authentication metadata is incomplete");
      }
      if (selected > 0 && object.size > PACK_BLOB_BATCH_TARGET_BYTES - selectedBytes) {
        break;
      }
      selectedBytes += object.size;
      selected++;
    }
    try {
      const selectedOids = remaining.slice(0, selected);
      const batch = repo.readObjects(selectedOids, { budgetBytes: Math.max(1, selectedBytes) });
      if (batch.objects.size !== selectedOids.length || batch.remaining.length !== 0) {
        throw new CorruptError("fetch object authentication made no progress");
      }
      for (const [oid, object] of batch.objects) {
        validateMappedObject(oid, object);
        rememberType(oid, object.type);
      }
      remaining = remaining.slice(selected);
    } catch (error) {
      if (hasErrorCode(error, "ENOTFOUND")) {
        throw new GitError("EFETCHFAIL", "fetch did not receive every selected object", {
          cause: error,
        });
      }
      throw error;
    }
  }
  return types;
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

export async function fetchMappedInto(
  context: GitContext,
  repo: Repository,
  options: FetchOperationOptions & MappedFetchSelection,
  behavior: FetchBehavior,
  refLogReason: "fetch" | "clone: fetch",
  remote: string,
  url: string,
  advertisement: Advertisement,
  auth: NonNullable<Parameters<typeof uploadPack>[1]>,
  refs: readonly ExpandedFetchRefspec[],
): Promise<FetchResult> {
  if (refs.length === 0) {
    await runFetchCheckpoint(behavior.checkpoint, "after-discovery", options.signal);
    return {
      mode: "mapped",
      defaultBranch: advertisement.headRef,
      fetchHead: null,
      updates: [],
    };
  }

  requireMappedBranchesAvailable(context, repo, refs);
  const publication = repo.store.beginFetchPublication(
    `refs/remotes/${remote}/`,
    refs.map((ref) => ref.destination),
  );
  try {
    preflightMappedUpdates(refs, publication);
    await runFetchCheckpoint(behavior.checkpoint, "after-discovery", options.signal);

    const tags = mappedTagTargets(advertisement, refs);
    const wants = [
      ...new Set([...refs.map((ref) => ref.oid), ...tags.map((tag) => tag.peeledOid)]),
    ];
    const say = fetchProgressSink(options.onProgress, options.onMessage);
    const transfer = await transferPack(
      context,
      repo,
      {
        url,
        wants,
        shallows: [],
        advertised: advertisement.capabilities,
        useLocalHaves: false,
        ...(options.filter === undefined ? {} : { filter: options.filter }),
        ...(options.filter === undefined ? {} : { promisorRemote: remote }),
      },
      auth,
      say,
      behavior.checkpoint,
    );
    if (transfer.shallow.length > 0 || transfer.unshallow.length > 0) {
      throw new CorruptError("mapped fetch received an unsolicited shallow response");
    }
    const types = authenticateMappedRoots(repo, refs);
    requireMappedUpdateRules(repo, refs, publication, types);
    authenticateTags(repo, tags);

    await runFetchCheckpoint(behavior.checkpoint, "before-ref-publication", options.signal);
    throwIfAborted(options.signal);
    withGitMutationGuardOwned(context.database, () => {
      repositoryMutations(repo).publishFetchRefsOwned(
        publication,
        {
          exactPuts: refs.map((ref) => ({ name: ref.destination, target: ref.oid })),
        },
        operationRefLogMetadata(context, repo, refLogReason),
      );
      publication.dispose();
    });
    const afterRefs = behavior.checkpoint?.("after-ref-publication");
    if (afterRefs !== undefined) await afterRefs;
    return {
      mode: "mapped",
      defaultBranch: advertisement.headRef,
      fetchHead: null,
      updates: refs.map((ref) => ({
        source: ref.source,
        destination: ref.destination,
        oid: ref.oid,
      })),
    };
  } finally {
    publication.dispose();
  }
}
