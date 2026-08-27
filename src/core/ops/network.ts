// clone and fetch: ref discovery, bounded negotiation, streaming pack
// ingest, then a transactional ref update.
//
// The ordering is the crash-safety contract. The pack is written and
// verified while it is invisible to reads; only once it is complete do the
// refs move, in one transaction. An interrupted fetch leaves every
// existing ref valid and one reclaimable pending pack.

import { MAX_BLOB_BATCH_BYTES } from "../../sqlite/store.js";
import { isOid } from "../bytes.js";
import type { GitContext } from "../context.js";
import { AlreadyInitializedError, CorruptError, GitError } from "../errors.js";
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
import { checkoutTree } from "./checkout.js";
import { isInitialCheckoutFallback, tryInitialCheckout } from "./initial-checkout.js";
import { operationRefLogMetadata } from "./ref-log.js";

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
}

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

function localTagNames(repo: Repository): Set<string> {
  return new Set(repo.store.listRefs("refs/tags/").map((ref) => ref.name));
}

function eligibleAutoTags(repo: Repository, tags: readonly AdvertisedTag[]): AdvertisedTag[] {
  const local = localTagNames(repo);
  const present = repo.store.hasAll(tags.map((tag) => tag.peeledOid));
  return tags.filter((tag) => !local.has(tag.ref.name) && present.has(tag.peeledOid));
}

function preflightAllTags(repo: Repository, tags: readonly AdvertisedTag[]): void {
  if (tags.length === 0) return;
  const existing = new Map(repo.store.listRefs("refs/tags/").map((ref) => [ref.name, ref.target]));
  for (const tag of tags) {
    const target = existing.get(tag.ref.name);
    if (target !== undefined && target !== tag.ref.oid) {
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
): Promise<void> {
  await repo.store.packs.ingest(pack, {
    ...(say === undefined ? {} : { onProgress: say }),
    now: context.now,
    ...(context.yieldNow === undefined ? {} : { yieldNow: context.yieldNow }),
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
): Promise<void> {
  if (request.wants.length === 0) return;
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
  await ingestPack(context, repo, result.pack, say);
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    repo.store.setShallow(result.shallow, result.unshallow);
    repo.invalidateShallow();
  }
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
  preflightAllTags(repo, requiredTags);

  const say = progressSink(options.onProgress, options.onMessage);
  const initialAutoTags = autoTags && tags.length > 0 ? eligibleAutoTags(repo, tags) : [];
  const transferRefs = [
    ...selection.coverage,
    ...(allTags ? tags.map((tag) => tag.ref) : initialAutoTags.map((tag) => tag.ref)),
  ];
  const requiredTagTargets = requiredTags.map((tag) => tag.peeledOid);
  const wants = repo.store.missing([...transferRefs.map((ref) => ref.oid), ...requiredTagTargets]);
  const shallows = [...repo.shallow()];
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
  );

  // A server without include-tag may omit annotated tag objects. Once their
  // peeled targets are local, one bounded fallback request completes them.
  if (autoTags && tags.length > 0) {
    const eligible = eligibleAutoTags(repo, tags);
    const fallbackWants = repo.store.missing(eligible.map((tag) => tag.ref.oid));
    const wanted = new Set(fallbackWants);
    await transferPack(
      context,
      repo,
      {
        url,
        wants: fallbackWants,
        shallows: [...repo.shallow()],
        advertised: advertisement.capabilities,
        haves: eligible.filter((tag) => wanted.has(tag.ref.oid)).map((tag) => tag.peeledOid),
      },
      auth,
      say,
    );
  }

  const finalAutoTags = autoTags && tags.length > 0 ? eligibleAutoTags(repo, tags) : [];
  const selectedTags = allTags ? tags : autoTags ? finalAutoTags : requiredTags;
  authenticateTags(repo, selectedTags);
  const publishedRefs = [
    ...selection.coverage.filter((ref) => !ref.name.startsWith("refs/tags/")),
    ...selectedTags.map((tag) => tag.ref),
  ];

  // One transaction: either every tracking ref moves or none does.
  const trackingPrefix = `refs/remotes/${remote}/`;
  const deletes: string[] = [];
  if (options.prune === true) {
    const advertised = new Set(
      advertisement.refs
        .filter((ref) => ref.name.startsWith("refs/heads/"))
        .map((ref) => `${trackingPrefix}${ref.name.slice("refs/heads/".length)}`),
    );
    for (const existing of repo.store.listRefs(trackingPrefix)) {
      if (!advertised.has(existing.name)) deletes.push(existing.name);
    }
  }
  const updates = [];
  for (const ref of publishedRefs) {
    if (ref.name.startsWith("refs/heads/")) {
      updates.push({
        name: `${trackingPrefix}${ref.name.slice("refs/heads/".length)}`,
        target: ref.oid,
      });
    } else if (ref.name.startsWith("refs/tags/")) {
      updates.push({ name: ref.name, target: ref.oid });
    }
  }
  // The remote's HEAD is a symref into *our* tracking namespace, not into
  // the local branches, and only once the branch it names has been fetched.
  const headRef = advertisement.headRef ?? "";
  if (headRef.startsWith("refs/heads/")) {
    const tracking = `${trackingPrefix}${headRef.slice("refs/heads/".length)}`;
    const updated = updates.some((ref) => ref.name === tracking);
    const retained = !deletes.includes(tracking) && repo.store.getRef(tracking) !== null;
    if (updated || retained) {
      updates.push({ name: `${trackingPrefix}HEAD`, target: `ref: ${tracking}` });
    }
  }
  preflightAllTags(repo, requiredTags);
  repo.mutateRefs({ puts: updates, deletes }, operationRefLogMetadata(context, repo, refLogReason));

  return {
    defaultBranch: advertisement.headRef,
    fetchHead: selection.result?.oid ?? null,
  };
}

function tryInitialClone(context: GitContext, repo: Repository, treeOid: string): boolean {
  try {
    return tryInitialCheckout(context, repo, treeOid);
  } catch (error) {
    if (isInitialCheckoutFallback(error)) return false;
    throw error;
  }
}

export async function clone(context: GitContext, options: CloneOptions): Promise<void> {
  const root = normalizePath(options.dir ?? "/");
  if (context.database.checkoutAt(root) !== null) throw new AlreadyInitializedError(root);
  const url = normalizeRemoteUrl(options.url);
  const remote = options.remote ?? "origin";

  const row = context.database.createRepository(root, "ref: refs/heads/main");
  const repo = new Repository(context.database.openCheckout(row));
  try {
    repo.store.configSet(`remote.${remote}.url`, url);
    repo.store.configSet(`remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`);

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
    );

    const branch = branchNameFor(options.ref, result.defaultBranch);
    const tip = result.fetchHead;
    if (tip === null) throw new GitError("EFETCHFAIL", "remote advertised no usable ref");

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

    const tree = repo.readCommit(repo.peel(tip)).tree;
    const initial = options.paths === undefined && tryInitialClone(context, repo, tree);
    if (!initial) {
      checkoutTree(repo, context.worktree, tree, {
        ...(options.paths === undefined ? {} : { paths: options.paths }),
      });
    }
  } catch (error) {
    // A clone that fails leaves nothing behind: the destination had no
    // repository before the call, so removing ours restores that.
    repo.store.destroy();
    throw error;
  }
}

function branchNameFor(requested: string | undefined, defaultBranch: string | null): string {
  const source = requested ?? defaultBranch ?? "refs/heads/main";
  return source.startsWith("refs/heads/") ? source.slice("refs/heads/".length) : source;
}
