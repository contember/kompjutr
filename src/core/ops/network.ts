// clone and fetch: ref discovery, bounded negotiation, streaming pack
// ingest, then a transactional ref update.
//
// The ordering is the crash-safety contract. The pack is written and
// verified while it is invisible to reads; only once it is complete do the
// refs move, in one transaction. An interrupted fetch leaves every
// existing ref valid and one reclaimable pending pack.

import {
  type CheckoutStore,
  type FetchPublicationToken,
  MAX_BLOB_BATCH_BYTES,
} from "../../sqlite/store.js";
import { isOid } from "../bytes.js";
import type { GitContext } from "../context.js";
import { CorruptError, GitError, hasErrorCode } from "../errors.js";
import { type ObjectType, parseTag, type RawObject } from "../objects.js";
import { normalizePath } from "../paths.js";
import { type MessageCallback, type ProgressCallback, progressSink } from "../protocol/progress.js";
import {
  type Advertisement,
  discover,
  normalizeRemoteUrl,
  type RemoteRef,
  uploadPack,
} from "../protocol/remote.js";
import { type AuthCallback, RemoteAuthSession } from "../protocol/transport.js";
import { Repository } from "../repository.js";
import { joinSorted } from "../streams.js";
import { checkoutTree, matchesPaths, type TargetEntry } from "./checkout.js";
import { isInitialCheckoutFallback, tryInitialCheckout } from "./initial-checkout.js";
import { operationRefLogMetadata } from "./ref-log.js";
import { treeStream } from "./tree-stream.js";
import { walkWorktreeEntriesStream } from "./worktree-io.js";

/** How many commits back from each local tip are offered as `have`s. */
const HAVE_BUDGET = 256;
const TAG_OBJECT_PAGE = 4_096;
const TAG_PEEL_HOPS = 16;
const TAG_AUTH_BYTES = 64 * 1024 * 1024;
const tagHeaderDecoder = new TextDecoder("utf-8", { fatal: true });

export interface RemoteAuthOptions {
  headers?: Record<string, string>;
  onAuth?: AuthCallback;
  /** Structured progress, as Computer's interface declares it. */
  onProgress?: ProgressCallback;
  /** The remote's side-band text, verbatim. */
  onMessage?: MessageCallback;
}

export interface CloneOptions extends RemoteAuthOptions {
  url: string;
  dir?: string;
  ref?: string;
  paths?: string[];
  depth?: number;
  singleBranch?: boolean;
  noTags?: boolean;
  remote?: string;
}

export interface FetchOptions extends RemoteAuthOptions {
  dir?: string;
  remote?: string;
  url?: string;
  ref?: string;
  remoteRef?: string;
  depth?: number;
  singleBranch?: boolean;
  tags?: boolean;
  prune?: boolean;
}

export interface FetchResult {
  defaultBranch: string | null;
  fetchHead: string | null;
}

interface FetchBehavior {
  /** Internal coverage selector, separate from the ref reported to a caller. */
  coverageRef?: string;
  /** Internal result selector, used by pull while it fetches broader coverage. */
  resultRef?: string;
  /** A configured selector auto-follows tags even when coverage is one branch. */
  autoTags?: boolean;
  /** Private lifecycle and deterministic-test checkpoint. */
  checkpoint?: (stage: FetchCheckpointStage) => Promise<void> | undefined;
}

type FetchCheckpointStage =
  | "before-discovery"
  | "after-discovery"
  | "before-upload"
  | "before-ingest"
  | "pack-ingest"
  | "after-ingest"
  | "after-shallow-response"
  | "before-ref-publication"
  | "after-ref-publication";

interface FetchSelection {
  coverage: RemoteRef[];
  result: RemoteRef | null;
}

interface AdvertisedTag {
  ref: RemoteRef;
  peeledOid: string;
}

export function remoteUrlFor(repo: Repository, remote: string): string | undefined {
  return repo.store.configGet(`remote.${remote}.url`);
}

function findAdvertisedRef(advertisement: Advertisement, wanted: string): RemoteRef {
  const { refs } = advertisement;
  const exact = refs.find((ref) => ref.name === wanted);
  if (exact !== undefined) return exact;
  for (const prefix of ["refs/heads/", "refs/tags/", "refs/remotes/"]) {
    const found = refs.find((ref) => ref.name === `${prefix}${wanted}`);
    if (found !== undefined) return found;
  }
  throw new GitError("EREFNOTFOUND", `couldn't find remote ref ${wanted}`);
}

/** Separate transfer coverage from the one ref returned as FETCH_HEAD. */
function selectRefs(
  advertisement: Advertisement,
  options: { coverageRef?: string; resultRef?: string; singleBranch: boolean },
): FetchSelection {
  let coverage: RemoteRef[];
  if (options.coverageRef !== undefined) {
    coverage = [findAdvertisedRef(advertisement, options.coverageRef)];
  } else if (options.singleBranch) {
    const head = advertisement.headRef;
    const branch = head === null ? undefined : advertisement.refs.find((ref) => ref.name === head);
    if (branch !== undefined) coverage = [branch];
    else {
      const fallback = advertisement.refs.find((ref) => ref.name.startsWith("refs/heads/"));
      if (fallback === undefined) throw new GitError("EREFNOTFOUND", "remote has no branches");
      coverage = [fallback];
    }
  } else {
    coverage = advertisement.refs.filter((ref) => ref.name.startsWith("refs/heads/"));
  }

  const result =
    options.resultRef !== undefined
      ? findAdvertisedRef(advertisement, options.resultRef)
      : advertisement.headRef === null
        ? (coverage[0] ?? null)
        : (advertisement.refs.find((ref) => ref.name === advertisement.headRef) ??
          coverage[0] ??
          null);
  return { coverage, result };
}

function advertisedTags(advertisement: Advertisement): AdvertisedTag[] {
  const peeled = new Map<string, string>();
  for (const ref of advertisement.refs) {
    if (ref.name.startsWith("refs/tags/") && ref.name.endsWith("^{}")) {
      peeled.set(ref.name.slice(0, -3), ref.oid);
    }
  }
  const tags: AdvertisedTag[] = [];
  for (const ref of advertisement.refs) {
    if (!ref.name.startsWith("refs/tags/") || ref.name.endsWith("^{}")) continue;
    tags.push({ ref, peeledOid: peeled.get(ref.name) ?? ref.oid });
  }
  return tags;
}

function snapshottedTagNames(snapshot: FetchPublicationToken): Set<string> {
  return new Set(snapshot.globalRefs.filter((ref) => ref.target !== null).map((ref) => ref.name));
}

function eligibleAutoTags(
  repo: Repository,
  tags: readonly AdvertisedTag[],
  snapshot: FetchPublicationToken,
): AdvertisedTag[] {
  const local = snapshottedTagNames(snapshot);
  const present = repo.store.hasAll(tags.map((tag) => tag.peeledOid));
  return tags.filter((tag) => !local.has(tag.ref.name) && present.has(tag.peeledOid));
}

function preflightAllTags(snapshot: FetchPublicationToken, tags: readonly AdvertisedTag[]): void {
  if (tags.length === 0) return;
  const existing = new Map(snapshot.globalRefs.map((ref) => [ref.name, ref.target]));
  for (const tag of tags) {
    const target = existing.get(tag.ref.name);
    if (target !== undefined && target !== null && target !== tag.ref.oid) {
      throw new GitError("ETAGFAIL", `fetch would clobber existing tag ${tag.ref.name}`);
    }
  }
}

interface TagAuthBudget {
  bytes: number;
}

function readTagObjects(
  repo: Repository,
  oids: readonly string[],
  budget: TagAuthBudget,
): Map<string, RawObject> {
  const objects = new Map<string, RawObject>();
  let pending = [...new Set(oids)];
  while (pending.length > 0) {
    if (budget.bytes >= TAG_AUTH_BYTES) {
      throw new GitError("E2BIG", `tag authentication exceeds ${TAG_AUTH_BYTES} bytes`);
    }
    const page = pending.slice(0, TAG_OBJECT_PAGE);
    const tail = pending.slice(TAG_OBJECT_PAGE);
    const batch = repo.readObjects(page, {
      budgetBytes: Math.min(MAX_BLOB_BATCH_BYTES, TAG_AUTH_BYTES - budget.bytes),
    });
    for (const [oid, object] of batch.objects) objects.set(oid, object);
    budget.bytes += batch.bytes;
    pending = [...batch.remaining, ...tail];
  }
  return objects;
}

interface TagPeelState {
  tag: AdvertisedTag;
  current: string;
  expectedType?: ObjectType;
  seen: Set<string>;
}

function objectTypes(repo: Repository, oids: readonly string[]): Map<string, ObjectType> {
  const types = new Map<string, ObjectType>();
  const unique = [...new Set(oids)];
  for (let offset = 0; offset < unique.length; offset += TAG_OBJECT_PAGE) {
    for (const info of repo.store.objectInfo(unique.slice(offset, offset + TAG_OBJECT_PAGE))) {
      types.set(info.oid, info.type);
    }
  }
  return types;
}

function parseAuthenticatedTag(name: string, data: Uint8Array) {
  let headerEnd = -1;
  for (let index = 0; index + 1 < data.length; index++) {
    if (data[index] === 0x0a && data[index + 1] === 0x0a) {
      headerEnd = index;
      break;
    }
  }
  if (headerEnd < 0) throw new CorruptError(`tag ${name} has no header terminator`);
  let text: string;
  try {
    text = tagHeaderDecoder.decode(data.subarray(0, headerEnd));
  } catch {
    throw new CorruptError(`tag ${name} has malformed header text`);
  }
  let objects = 0;
  let types = 0;
  let names = 0;
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) throw new CorruptError(`tag ${name} has a malformed header`);
    const key = line.slice(0, space);
    if (key === "object") objects++;
    else if (key === "type") types++;
    else if (key === "tag") names++;
  }
  if (objects !== 1 || types !== 1 || names !== 1) {
    throw new CorruptError(`tag ${name} does not have exactly one object, type, and tag header`);
  }
  return parseTag(data);
}

/** Authenticate every annotated tag against the advertisement before publication. */
function authenticateTags(repo: Repository, tags: readonly AdvertisedTag[]): void {
  const unique = new Map<string, AdvertisedTag>();
  for (const tag of tags) unique.set(tag.ref.name, tag);
  const required = [...unique.values()];
  const requiredOids: string[] = [];
  for (const tag of required) requiredOids.push(tag.ref.oid, tag.peeledOid);
  const held = repo.store.hasAll(new Set(requiredOids));
  for (const tag of required) {
    if (!held.has(tag.ref.oid) || !held.has(tag.peeledOid)) {
      throw new GitError("EFETCHFAIL", `fetch did not receive complete tag ${tag.ref.name}`);
    }
  }

  const rootTypes = objectTypes(
    repo,
    required.map((tag) => tag.ref.oid),
  );
  const pendingRoots: TagPeelState[] = [];
  for (const tag of required) {
    const rootType = rootTypes.get(tag.ref.oid);
    if (rootType === undefined) {
      throw new GitError("EFETCHFAIL", `fetch did not receive complete tag ${tag.ref.name}`);
    }
    if (rootType === "tag") {
      if (tag.ref.oid === tag.peeledOid) {
        throw new CorruptError(`annotated tag ${tag.ref.name} has no advertised peeled target`);
      }
      pendingRoots.push({ tag, current: tag.ref.oid, seen: new Set<string>() });
    } else if (tag.ref.oid !== tag.peeledOid) {
      throw new CorruptError(`tag ${tag.ref.name} has an invalid advertised peeled target`);
    }
  }
  let pending = pendingRoots;
  const budget = { bytes: 0 };
  for (let hop = 0; hop < TAG_PEEL_HOPS && pending.length > 0; hop++) {
    const frontier = new Set(pending.map((state) => state.current));
    const heldFrontier = repo.store.hasAll(frontier);
    for (const state of pending) {
      if (!heldFrontier.has(state.current)) {
        throw new GitError(
          "EFETCHFAIL",
          `fetch did not receive complete tag ${state.tag.ref.name}`,
        );
      }
    }
    const objects = readTagObjects(repo, [...frontier], budget);
    const next: TagPeelState[] = [];
    for (const state of pending) {
      const object = objects.get(state.current);
      if (object === undefined) {
        throw new GitError(
          "EFETCHFAIL",
          `fetch did not receive complete tag ${state.tag.ref.name}`,
        );
      }
      if (state.expectedType !== undefined && object.type !== state.expectedType) {
        throw new CorruptError(`tag ${state.tag.ref.name} has a mismatched target type`);
      }
      if (object.type !== "tag") {
        if (state.current !== state.tag.peeledOid) {
          throw new CorruptError(`tag ${state.tag.ref.name} does not match its advertised target`);
        }
        continue;
      }
      if (state.seen.has(state.current)) {
        throw new CorruptError(`tag ${state.tag.ref.name} contains a cycle`);
      }
      state.seen.add(state.current);
      const parsed = parseAuthenticatedTag(state.tag.ref.name, object.data);
      next.push({
        tag: state.tag,
        current: parsed.object,
        expectedType: parsed.type,
        seen: state.seen,
      });
    }
    pending = next;
  }
  if (pending.length > 0) {
    throw new CorruptError(`tag ${pending[0]!.tag.ref.name} exceeds ${TAG_PEEL_HOPS} peel hops`);
  }
}

/** Recent commits from every local ref, as negotiation `have`s. */
function collectHaves(repo: Repository): string[] {
  const haves: string[] = [];
  const seen = new Set<string>();
  const tips = repo.store
    .listRefs()
    .map((ref) => ref.target)
    .filter((target) => isOid(target));
  const head = repo.head().oid;
  if (head !== null) tips.unshift(head);
  const unique = [...new Set(tips)];
  const present = repo.store.hasAll(unique);
  for (const tip of unique) {
    if (!present.has(tip)) continue;
    try {
      for (const { oid } of repo.walk(tip)) {
        if (seen.has(oid)) break;
        seen.add(oid);
        haves.push(oid);
        if (haves.length >= HAVE_BUDGET) return haves;
      }
    } catch {
      // A tip whose history is not fully present contributes nothing.
    }
  }
  return haves;
}

async function ingestPack(
  context: GitContext,
  repo: Repository,
  pack: AsyncIterable<Uint8Array>,
  say: ((text: string) => void) | undefined,
  checkpoint: ((stage: FetchCheckpointStage) => Promise<void> | undefined) | undefined,
): Promise<void> {
  const yieldNow =
    checkpoint === undefined
      ? context.yieldNow
      : async (): Promise<void> => {
          const pending = checkpoint("pack-ingest");
          if (pending !== undefined) await pending;
        };
  await repo.store.packs.ingest(pack, {
    ...(say === undefined ? {} : { onProgress: say }),
    now: context.now,
    ...(yieldNow === undefined ? {} : { yieldNow }),
  });
}

async function transferPack(
  context: GitContext,
  repo: Repository,
  request: {
    url: string;
    wants: string[];
    shallows: string[];
    depth?: number;
    includeTag?: boolean;
    advertised: Set<string>;
    haves?: string[];
  },
  auth: Parameters<typeof uploadPack>[1],
  say: ((text: string) => void) | undefined,
  checkpoint: ((stage: FetchCheckpointStage) => Promise<void> | undefined) | undefined,
): Promise<{ shallow: string[]; unshallow: string[] }> {
  if (request.wants.length === 0) return { shallow: [], unshallow: [] };
  const beforeUpload = checkpoint?.("before-upload");
  if (beforeUpload !== undefined) await beforeUpload;
  const result = await uploadPack(
    {
      url: request.url,
      wants: request.wants,
      haves: [...new Set([...collectHaves(repo), ...(request.haves ?? [])])],
      shallows: request.shallows,
      advertised: request.advertised,
      ...(request.depth === undefined ? {} : { depth: request.depth }),
      ...(request.includeTag === undefined ? {} : { includeTag: request.includeTag }),
      ...(say === undefined ? {} : { onProgress: say, onMessage: say }),
    },
    auth,
  );
  const beforeIngest = checkpoint?.("before-ingest");
  if (beforeIngest !== undefined) await beforeIngest;
  await ingestPack(context, repo, result.pack, say, checkpoint);
  const afterIngest = checkpoint?.("after-ingest");
  if (afterIngest !== undefined) await afterIngest;
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    const afterShallow = checkpoint?.("after-shallow-response");
    if (afterShallow !== undefined) await afterShallow;
  }
  return { shallow: result.shallow, unshallow: result.unshallow };
}

function accumulateShallow(
  target: { add: Set<string>; remove: Set<string> },
  source: { shallow: readonly string[]; unshallow: readonly string[] },
): void {
  for (const oid of source.unshallow) {
    target.add.delete(oid);
    target.remove.add(oid);
  }
  for (const oid of source.shallow) {
    target.remove.delete(oid);
    target.add.add(oid);
  }
}

function effectiveShallows(
  baseline: readonly string[],
  mutation: { add: ReadonlySet<string>; remove: ReadonlySet<string> },
): string[] {
  const effective = new Set(baseline);
  for (const oid of mutation.remove) effective.delete(oid);
  for (const oid of mutation.add) effective.add(oid);
  return [...effective];
}

export async function fetchInto(
  context: GitContext,
  repo: Repository,
  options: FetchOptions,
  refLogReason: "fetch" | "clone: fetch" = "fetch",
  behavior: FetchBehavior = {},
): Promise<FetchResult> {
  const remote = options.remote ?? "origin";
  const url = options.url ?? remoteUrlFor(repo, remote);
  if (url === undefined) throw new GitError("ENOREMOTE", `no such remote: ${remote}`);

  const auth = {
    ...(context.http === undefined ? {} : { http: context.http }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.onAuth === undefined ? {} : { onAuth: options.onAuth }),
    authSession: new RemoteAuthSession(),
  };
  const beforeDiscovery = behavior.checkpoint?.("before-discovery");
  if (beforeDiscovery !== undefined) await beforeDiscovery;
  const advertisement = await discover(url, "git-upload-pack", auth);
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
  const autoTags = options.tags === undefined && (behavior.autoTags ?? requestedRef === undefined);
  const allTags = options.tags === true;
  const tags = advertisedTags(advertisement);
  const selectedTagNames = new Set(
    selection.coverage.filter((ref) => ref.name.startsWith("refs/tags/")).map((ref) => ref.name),
  );
  const requiredTags = tags.filter((tag) => allTags || selectedTagNames.has(tag.ref.name));
  const candidateTags = allTags || autoTags ? tags : requiredTags;
  const trackingPrefix = `refs/remotes/${remote}/`;
  const publication = repo.beginFetchPublication(
    trackingPrefix,
    candidateTags.map((tag) => tag.ref.name),
  );

  try {
    preflightAllTags(publication, requiredTags);
    const afterDiscovery = behavior.checkpoint?.("after-discovery");
    if (afterDiscovery !== undefined) await afterDiscovery;

    const say = progressSink(options.onProgress, options.onMessage);
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
    const wants =
      options.depth !== undefined && options.depth > 0 && !depthOneAlreadyPublished
        ? [...new Set(wantedOids)]
        : repo.store.missing(wantedOids);
    const shallows = [...publication.shallow];
    const shallow = { add: new Set<string>(), remove: new Set<string>() };
    accumulateShallow(
      shallow,
      await transferPack(
        context,
        repo,
        {
          url,
          wants,
          shallows,
          advertised: advertisement.capabilities,
          ...(options.depth === undefined ? {} : { depth: options.depth }),
          ...(autoTags ? { includeTag: true } : {}),
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
      accumulateShallow(
        shallow,
        await transferPack(
          context,
          repo,
          {
            url,
            wants: fallbackWants,
            shallows: effectiveShallows(shallows, shallow),
            advertised: advertisement.capabilities,
            haves: eligible.filter((tag) => wanted.has(tag.ref.oid)).map((tag) => tag.peeledOid),
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
    const publishedRefs = selection.coverage.filter((ref) => !ref.name.startsWith("refs/tags/"));

    const trackingPuts = publishedRefs
      .filter((ref) => ref.name.startsWith("refs/heads/"))
      .map((ref) => ({
        name: `${trackingPrefix}${ref.name.slice("refs/heads/".length)}`,
        target: ref.oid,
      }));
    const trackingKeep =
      options.prune === true
        ? advertisement.refs
            .filter((ref) => ref.name.startsWith("refs/heads/"))
            .map((ref) => `${trackingPrefix}${ref.name.slice("refs/heads/".length)}`)
        : undefined;
    const retainedTracking = new Set(publication.trackingRefs.map((ref) => ref.name));
    const keptTracking = new Set(trackingKeep ?? retainedTracking);
    const updatedTracking = new Set(trackingPuts.map((ref) => ref.name));
    let remoteHead: string | null | undefined;
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

    const beforeRefs = behavior.checkpoint?.("before-ref-publication");
    if (beforeRefs !== undefined) await beforeRefs;
    repo.publishFetchRefs(
      publication,
      {
        trackingPuts,
        ...(trackingKeep === undefined ? {} : { trackingKeep }),
        ...(remoteHead === undefined ? {} : { remoteHead }),
        globalTagPuts: selectedTags.map((tag) => ({ name: tag.ref.name, target: tag.ref.oid })),
        shallowAdd: shallow.add,
        shallowRemove: shallow.remove,
      },
      operationRefLogMetadata(context, repo, refLogReason),
    );
    publication.dispose();
    const afterRefs = behavior.checkpoint?.("after-ref-publication");
    if (afterRefs !== undefined) await afterRefs;

    return {
      defaultBranch: advertisement.headRef,
      fetchHead: selection.result?.oid ?? null,
    };
  } finally {
    publication.dispose();
  }
}

function tryInitialClone(context: GitContext, repo: Repository, treeOid: string): boolean {
  return tryInitialCheckout(context, repo, treeOid, { requireSharedDatabase: true });
}

function* cloneTargetEntries(
  repo: Repository,
  treeOid: string,
  paths: string[] | undefined,
): Generator<TargetEntry> {
  for (const entry of treeStream(repo, treeOid)) {
    if (entry.mode !== "160000" && matchesPaths(entry.path, paths)) yield entry;
  }
}

function requireCloneTargetsAbsent(
  context: GitContext,
  repo: Repository,
  treeOid: string,
  paths: string[] | undefined,
): void {
  let existingLeafAncestor: string | null = null;
  for (const row of joinSorted(
    cloneTargetEntries(repo, treeOid, paths),
    walkWorktreeEntriesStream(context.worktree, repo.root, {
      includeDirectories: true,
      includeIgnored: true,
    }),
    { left: (entry) => entry.path, right: (entry) => entry.path },
  )) {
    if (
      existingLeafAncestor !== null &&
      row.path !== existingLeafAncestor &&
      !row.path.startsWith(`${existingLeafAncestor}/`)
    ) {
      existingLeafAncestor = null;
    }
    if (row.left !== undefined && (row.right !== undefined || existingLeafAncestor !== null)) {
      throw new GitError("EEXIST", `clone target path already exists: ${row.left.path}`);
    }
    if (row.right !== undefined && row.right.stat.type !== "dir") {
      existingLeafAncestor = row.right.path;
    }
  }
}

export async function clone(context: GitContext, options: CloneOptions): Promise<void> {
  const root = normalizePath(options.dir ?? "/");
  if (context.worktree.db !== context.database.db) {
    throw new GitError(
      "EUNSUPPORTED",
      "clone requires the working tree and Git store to share one database",
    );
  }
  const url = normalizeRemoteUrl(options.url);
  const remote = options.remote ?? "origin";
  const cleanup = (store: CheckoutStore): undefined => {
    checkoutTree(new Repository(store), context.worktree, null);
    return undefined;
  };
  const owner = context.database.beginProvisionalClone(
    root,
    "ref: refs/heads/main",
    context.now(),
    cleanup,
  );
  const repo = new Repository(owner.store);
  const heartbeat = (): void => {
    context.database.renewProvisionalClone(owner, context.now());
  };
  const checkpoint = (): Promise<void> | undefined => {
    heartbeat();
    const yieldNow = context.yieldNow;
    if (yieldNow === undefined) return;
    return (async () => {
      await yieldNow();
      heartbeat();
    })();
  };
  try {
    heartbeat();
    repo.store.configSet(`remote.${remote}.url`, url);
    repo.store.configSet(`remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`);
    heartbeat();

    const depth = options.depth ?? 1;
    const result = await fetchInto(
      context,
      repo,
      {
        remote,
        url,
        singleBranch: options.singleBranch ?? true,
        tags: !(options.noTags ?? true),
        ...(options.ref === undefined ? {} : { ref: options.ref }),
        ...(depth > 0 && Number.isFinite(depth) ? { depth } : {}),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.onAuth === undefined ? {} : { onAuth: options.onAuth }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
      },
      "clone: fetch",
      { checkpoint },
    );

    const branch = branchNameFor(options.ref, result.defaultBranch);
    const tip = result.fetchHead;
    if (tip === null) throw new GitError("EFETCHFAIL", "remote advertised no usable ref");

    heartbeat();
    repo.store.db.transactionSync(() => {
      repo.mutateRefs(
        {
          puts: [{ name: `refs/heads/${branch}`, target: tip }],
          head: `ref: refs/heads/${branch}`,
        },
        operationRefLogMetadata(context, repo, "clone: checkout"),
      );
      repo.store.configSet(`branch.${branch}.remote`, remote);
      repo.store.configSet(`branch.${branch}.merge`, `refs/heads/${branch}`);
    });
    const afterLocalRefs = checkpoint();
    if (afterLocalRefs !== undefined) await afterLocalRefs;

    const tree = repo.readCommit(repo.peel(tip)).tree;
    const beforeMaterialization = checkpoint();
    if (beforeMaterialization !== undefined) await beforeMaterialization;
    const fallback = (): undefined => {
      requireCloneTargetsAbsent(context, repo, tree, options.paths);
      checkoutTree(repo, context.worktree, tree, {
        ...(options.paths === undefined ? {} : { paths: options.paths }),
      });
      return undefined;
    };
    try {
      context.database.publishProvisionalClone(owner, context.now(), () => {
        const initial = options.paths === undefined && tryInitialClone(context, repo, tree);
        if (!initial) return fallback();
        return undefined;
      });
    } catch (error) {
      if (!isInitialCheckoutFallback(error)) throw error;
      context.database.publishProvisionalClone(owner, context.now(), fallback);
    }
  } catch (error) {
    try {
      context.database.discardProvisionalClone(owner, context.now(), cleanup);
    } catch (discardError) {
      if (!hasErrorCode(discardError, "ESTALE")) throw discardError;
    }
    throw error;
  }
}

function branchNameFor(requested: string | undefined, defaultBranch: string | null): string {
  const source = requested ?? defaultBranch ?? "refs/heads/main";
  return source.startsWith("refs/heads/") ? source.slice("refs/heads/".length) : source;
}
