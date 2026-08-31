// clone and fetch: ref discovery, bounded negotiation, streaming pack
// ingest, then a transactional ref update.
//
// The ordering is the crash-safety contract. The pack is written and
// verified while it is invisible to reads; only once it is complete do the
// refs move, in one transaction. An interrupted fetch leaves every
// existing ref valid and one reclaimable pending pack.

import { isOid } from "../common/bytes.js";
import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import {
  hashObject,
  type ObjectType,
  parseCommit,
  parseTag,
  parseTree,
  type RawObject,
} from "../common/objects.js";
import { normalizePath } from "../common/paths.js";
import { joinSorted } from "../common/streams.js";
import { type MessageCallback, type ProgressCallback, progressSink } from "../protocol/progress.js";
import {
  type Advertisement,
  discover,
  normalizeRemoteUrl,
  type RemoteRef,
  uploadPack,
} from "../protocol/remote.js";
import { type AuthCallback, type GitAuth, RemoteAuthSession } from "../protocol/transport.js";
import {
  type CheckoutStore,
  type FetchPublicationPlan,
  type FetchPublicationToken,
  listCheckoutsOwned,
  PACK_BLOB_BATCH_TARGET_BYTES,
  PROVISIONAL_CLONE_LEASE_MS,
  PROVISIONAL_CLONE_RENEW_WINDOW_MS,
} from "../store/index.js";
import { checkoutTree, matchesPaths, type TargetEntry } from "./checkout.js";
import type { GitContext } from "./context.js";
import { isInitialCheckoutFallback, tryInitialCheckout } from "./initial-checkout.js";
import { selectMergeBases } from "./merge-base.js";
import { operationRefLogMetadata } from "./ref-log.js";
import {
  compileFetchRefspecs,
  type ExpandedFetchRefspec,
  type FetchRefspec,
  type RemoteTarget,
  type FetchResult as StructuredFetchResult,
} from "./refspec.js";
import { Repository, walkOwned } from "./repository.js";
import { treeStream } from "./tree-stream.js";
import { walkWorktreeEntriesStream } from "./worktree-io.js";

/** How many commits back from each local tip are offered as `have`s. */
const HAVE_BUDGET = 256;
const TAG_OBJECT_PAGE = 4_096;
const TAG_PEEL_HOPS = 16;
const tagHeaderDecoder = new TextDecoder("utf-8", { fatal: true });

export interface RemoteAuthOptions {
  headers?: Record<string, string>;
  onAuth?: AuthCallback;
  /** Structured progress, as Computer's interface declares it. */
  onProgress?: ProgressCallback;
  /** The remote's side-band text, verbatim. */
  onMessage?: MessageCallback;
}

/** Validate the static remote/auth callback surface before any network request. */
export function validateRemoteAuthOptions(options: unknown): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitError("EINVAL", "remote options must be an object");
  }
  validateFetchHeaders(Reflect.get(options, "headers"), "EINVAL");
  for (const field of ["onAuth", "onProgress", "onMessage"]) {
    const callback = Reflect.get(options, field);
    if (callback !== undefined && typeof callback !== "function") {
      throw new GitError("EINVAL", `remote ${field} must be a function`);
    }
  }
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

interface MappedFetchSelection {
  readonly refspecs: readonly [FetchRefspec, ...FetchRefspec[]];
  readonly depth?: never;
  readonly ref?: never;
  readonly remoteRef?: never;
  readonly singleBranch?: never;
  readonly prune?: never;
  readonly tags?: never;
}

interface LegacyFetchSelection {
  readonly refspecs?: never;
  readonly ref?: string;
  readonly remoteRef?: string;
  readonly depth?: number;
  readonly singleBranch?: boolean;
  readonly prune?: boolean;
  readonly tags?: boolean;
}

export type FetchOptions = RemoteAuthOptions & { readonly dir?: string } & RemoteTarget &
  (MappedFetchSelection | LegacyFetchSelection);

export type FetchResult = StructuredFetchResult;

/** Internal clone/concurrency callers may pin both the configured name and its observed URL. */
type FetchOperationOptions = RemoteAuthOptions & {
  readonly dir?: string;
  readonly remote?: string;
  readonly url?: string;
} & (MappedFetchSelection | LegacyFetchSelection);

function isMappedFetchOptions(
  options: FetchOperationOptions,
): options is FetchOperationOptions & MappedFetchSelection {
  return options.refspecs !== undefined;
}

export function validateFetchOptions(options: unknown): void {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new GitError("EINVAL", "fetch options must be an object");
  }
  validateRemoteAuthOptions(options);
  if (!("remote" in options) && !("url" in options) && !("refspecs" in options)) {
    return;
  }
  const remote = Reflect.get(options, "remote");
  const url = Reflect.get(options, "url");
  if (remote !== undefined && url !== undefined) {
    throw new GitError("EINVAL", "fetch accepts either remote or url, not both");
  }
  if (remote !== undefined && (typeof remote !== "string" || remote === "")) {
    throw new GitError("EINVAL", "fetch remote must be a non-empty string");
  }
  if (url !== undefined && typeof url !== "string") {
    throw new GitError("EINVAL", "fetch url must be a string");
  }
  const refspecs = Reflect.get(options, "refspecs");
  if (refspecs !== undefined) {
    if (!Array.isArray(refspecs)) throw new GitError("EINVAL", "fetch refspecs must be an array");
    for (const field of ["depth", "ref", "remoteRef", "singleBranch", "prune", "tags"]) {
      if (Reflect.get(options, field) !== undefined) {
        throw new GitError("EINVAL", `mapped fetch cannot set ${field}`);
      }
    }
  }
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

interface LegacyFetchResult {
  readonly mode: "legacy";
  readonly defaultBranch: string | null;
  readonly fetchHead: string | null;
  readonly updates: readonly [];
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

function readTagObjects(repo: Repository, oids: readonly string[]): Map<string, RawObject> {
  const objects = new Map<string, RawObject>();
  let pending = [...new Set(oids)];
  while (pending.length > 0) {
    const page = pending.slice(0, TAG_OBJECT_PAGE);
    const tail = pending.slice(TAG_OBJECT_PAGE);
    const info = repo.store.objectInfo(page);
    let selected = 0;
    let selectedBytes = 0;
    while (selected < info.length) {
      const entry = info[selected];
      const oid = page[selected];
      if (entry === undefined || oid === undefined || entry.oid !== oid) {
        throw new CorruptError("tag authentication metadata is incomplete");
      }
      if (selected > 0 && entry.size > PACK_BLOB_BATCH_TARGET_BYTES - selectedBytes) {
        break;
      }
      selectedBytes += entry.size;
      selected++;
    }
    const selectedOids = page.slice(0, selected);
    const batch = repo.readObjects(selectedOids, {
      budgetBytes: Math.max(1, selectedBytes),
    });
    if (batch.remaining.length > 0 || batch.objects.size !== selectedOids.length) {
      throw new CorruptError("tag authentication made no progress");
    }
    for (const [oid, object] of batch.objects) {
      if (hashObject(object.type, object.data) !== oid) {
        throw new CorruptError(`tag object ${oid} does not match its bytes`);
      }
      objects.set(oid, object);
    }
    pending = [...page.slice(selected), ...tail];
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
    const objects = readTagObjects(repo, [...frontier]);
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
    const first = pending[0];
    if (first === undefined) throw new CorruptError("tag peel state is incomplete");
    throw new CorruptError(`tag ${first.tag.ref.name} exceeds ${TAG_PEEL_HOPS} peel hops`);
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
      for (const { oid } of walkOwned(repo, tip)) {
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
    useLocalHaves?: boolean;
  },
  auth: Parameters<typeof uploadPack>[1],
  say: ((text: string) => void) | undefined,
  checkpoint: ((stage: FetchCheckpointStage) => Promise<void> | undefined) | undefined,
): Promise<{ shallow: string[]; unshallow: string[] }> {
  if (request.wants.length === 0) return { shallow: [], unshallow: [] };
  const beforeUpload = checkpoint?.("before-upload");
  if (beforeUpload !== undefined) await beforeUpload;
  let result: Awaited<ReturnType<typeof uploadPack>>;
  try {
    const haves = [
      ...new Set([
        ...(request.useLocalHaves === false ? [] : collectHaves(repo)),
        ...(request.haves ?? []),
      ]),
    ];
    result = await uploadPack(
      {
        url: request.url,
        wants: request.wants,
        haves,
        shallows: request.shallows,
        advertised: request.advertised,
        ...(request.depth === undefined ? {} : { depth: request.depth }),
        ...(request.includeTag === undefined ? {} : { includeTag: request.includeTag }),
        ...(say === undefined ? {} : { onProgress: say, onMessage: say }),
      },
      auth,
    );
  } catch (error) {
    if (isPublicFetchNetworkError(error)) throw error;
    throw new GitError("EHTTP", "upload-pack request failed", { cause: error });
  }
  const beforeIngest = checkpoint?.("before-ingest");
  if (beforeIngest !== undefined) await beforeIngest;
  await ingestPack(context, repo, fetchPackStream(result.pack), say, checkpoint);
  const afterIngest = checkpoint?.("after-ingest");
  if (afterIngest !== undefined) await afterIngest;
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    const afterShallow = checkpoint?.("after-shallow-response");
    if (afterShallow !== undefined) await afterShallow;
  }
  return { shallow: result.shallow, unshallow: result.unshallow };
}

async function* fetchPackStream(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  try {
    yield* source;
  } catch (error) {
    if (isPublicFetchNetworkError(error)) throw error;
    throw new GitError("EHTTP", "upload-pack response stream failed", { cause: error });
  }
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

function validateFetchHeaders(headers: unknown, code: "EAUTH" | "EINVAL"): void {
  if (headers === undefined) return;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new GitError(code, "remote authentication headers must be a string record");
  }
  for (const value of Object.values(headers)) {
    if (typeof value !== "string") {
      throw new GitError(code, "remote authentication headers must contain strings");
    }
  }
}

function validateFetchCredentials(credentials: GitAuth | undefined): void {
  if (credentials === undefined) return;
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    throw new GitError("EAUTH", "remote authentication callback returned invalid credentials");
  }
  if (credentials.username !== undefined && typeof credentials.username !== "string") {
    throw new GitError("EAUTH", "remote authentication username must be a string");
  }
  if (credentials.password !== undefined && typeof credentials.password !== "string") {
    throw new GitError("EAUTH", "remote authentication password must be a string");
  }
  validateFetchHeaders(credentials.headers, "EAUTH");
}

function fetchRemoteUrl(
  repo: Repository,
  options: FetchOperationOptions,
): { readonly remote: string; readonly url: string } {
  if (options.url !== undefined) {
    if (typeof options.url !== "string") throw new GitError("EINVAL", "fetch url must be a string");
    return { remote: options.remote ?? "origin", url: options.url };
  }
  if (
    options.remote !== undefined &&
    (typeof options.remote !== "string" || options.remote === "")
  ) {
    throw new GitError("EINVAL", "fetch remote must be a non-empty string");
  }
  const remote = options.remote ?? "origin";
  const url = remoteUrlFor(repo, remote);
  if (url === undefined) throw new GitError("ENOREMOTE", `no such remote: ${remote}`);
  return { remote, url };
}

/** Build one authenticated remote session. */
export function createRemoteAuth(context: GitContext, options: RemoteAuthOptions) {
  validateRemoteAuthOptions(options);
  const onAuth = options.onAuth;
  return {
    ...(context.http === undefined ? {} : { http: context.http }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(onAuth === undefined
      ? {}
      : {
          onAuth: async (...input: Parameters<typeof onAuth>) => {
            let credentials: GitAuth | undefined;
            try {
              credentials = await onAuth(...input);
            } catch (cause) {
              throw new GitError("EAUTH", "remote authentication callback failed", { cause });
            }
            validateFetchCredentials(credentials);
            return credentials;
          },
        }),
    authSession: new RemoteAuthSession(),
  };
}

function fetchAuth(context: GitContext, options: FetchOperationOptions) {
  return createRemoteAuth(context, options);
}

function fetchProgressSink(
  onProgress: ProgressCallback | undefined,
  onMessage: MessageCallback | undefined,
): ((text: string) => void) | undefined {
  const sink = progressSink(onProgress, onMessage);
  if (sink === undefined) return undefined;
  return (text: string): void => {
    try {
      sink(text);
    } catch (cause) {
      throw new GitError("EFETCHFAIL", "fetch progress callback failed", { cause });
    }
  };
}

function isPublicFetchNetworkError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (
    error.code === "EHTTP" ||
    error.code === "EFETCHFAIL" ||
    error.code === "ECORRUPT" ||
    error.code === "E2BIG" ||
    error.code === "EAUTH" ||
    error.code === "EURLSCHEME"
  );
}

async function fetchAdvertisement(
  url: string,
  auth: Parameters<typeof discover>[2],
): Promise<Advertisement> {
  try {
    return await discover(url, "git-upload-pack", auth);
  } catch (error) {
    if (isPublicFetchNetworkError(error)) throw error;
    throw new GitError("EHTTP", "upload-pack discovery request failed", { cause: error });
  }
}

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

export async function fetchInto(
  context: GitContext,
  repo: Repository,
  options: FetchOperationOptions,
  refLogReason: "fetch" | "clone: fetch" = "fetch",
  behavior: FetchBehavior = {},
): Promise<FetchResult> {
  if (isMappedFetchOptions(options)) validateFetchOptions(options);
  const compiler = isMappedFetchOptions(options)
    ? compileFetchRefspecs(options.refspecs)
    : undefined;
  const { remote, url } = fetchRemoteUrl(repo, options);
  const auth = fetchAuth(context, options);
  const beforeDiscovery = behavior.checkpoint?.("before-discovery");
  if (beforeDiscovery !== undefined) await beforeDiscovery;
  const advertisement = await fetchAdvertisement(url, auth);
  if (isMappedFetchOptions(options)) {
    if (compiler === undefined) throw new Error("mapped fetch lost its compiled refspecs");
    return await fetchMappedInto(
      context,
      repo,
      options,
      behavior,
      refLogReason,
      remote,
      url,
      advertisement,
      auth,
      compiler.expand(advertisement.refs),
    );
  }
  return await fetchLegacyInto(
    context,
    repo,
    options,
    behavior,
    refLogReason,
    remote,
    url,
    advertisement,
    auth,
  );
}

async function fetchMappedInto(
  context: GitContext,
  repo: Repository,
  options: FetchOperationOptions & MappedFetchSelection,
  behavior: FetchBehavior,
  refLogReason: "fetch" | "clone: fetch",
  remote: string,
  url: string,
  advertisement: Advertisement,
  auth: Parameters<typeof uploadPack>[1],
  refs: readonly ExpandedFetchRefspec[],
): Promise<FetchResult> {
  if (refs.length === 0) {
    const afterDiscovery = behavior.checkpoint?.("after-discovery");
    if (afterDiscovery !== undefined) await afterDiscovery;
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
    const afterDiscovery = behavior.checkpoint?.("after-discovery");
    if (afterDiscovery !== undefined) await afterDiscovery;

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

    const beforeRefs = behavior.checkpoint?.("before-ref-publication");
    if (beforeRefs !== undefined) await beforeRefs;
    repo.publishFetchRefs(
      publication,
      {
        exactPuts: refs.map((ref) => ({ name: ref.destination, target: ref.oid })),
      },
      operationRefLogMetadata(context, repo, refLogReason),
    );
    publication.dispose();
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

interface PreparedLegacyFetchPublication {
  readonly publication: FetchPublicationToken;
  plan: FetchPublicationPlan | null;
  readonly result: LegacyFetchResult;
}

async function prepareLegacyFetchPublication(
  context: GitContext,
  repo: Repository,
  options: FetchOperationOptions & LegacyFetchSelection,
  behavior: FetchBehavior,
  remote: string,
  url: string,
  advertisement: Advertisement,
  auth: Parameters<typeof uploadPack>[1],
): Promise<PreparedLegacyFetchPublication> {
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
    const afterDiscovery = behavior.checkpoint?.("after-discovery");
    if (afterDiscovery !== undefined) await afterDiscovery;

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
      shallowAdd: [...shallow.add],
      shallowRemove: [...shallow.remove],
    };
    return { publication, plan, result };
  } catch (error) {
    publication.dispose();
    throw error;
  }
}

async function fetchLegacyInto(
  context: GitContext,
  repo: Repository,
  options: FetchOperationOptions & LegacyFetchSelection,
  behavior: FetchBehavior,
  refLogReason: "fetch" | "clone: fetch",
  remote: string,
  url: string,
  advertisement: Advertisement,
  auth: Parameters<typeof uploadPack>[1],
): Promise<FetchResult> {
  const prepared = await prepareLegacyFetchPublication(
    context,
    repo,
    options,
    behavior,
    remote,
    url,
    advertisement,
    auth,
  );
  let plan = prepared.plan;
  try {
    if (plan === null) throw new Error("legacy fetch lost its publication plan");
    repo.store.publishFetchRefs(
      prepared.publication,
      plan,
      operationRefLogMetadata(context, repo, refLogReason),
    );
    prepared.publication.dispose();
    plan = null;
    prepared.plan = null;
    const afterRefs = behavior.checkpoint?.("after-ref-publication");
    if (afterRefs !== undefined) await afterRefs;
    return prepared.result;
  } finally {
    prepared.publication.dispose();
    plan = null;
    prepared.plan = null;
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
  const cloneStartedAt = context.now();
  const owner = context.database.beginProvisionalClone(
    root,
    "ref: refs/heads/main",
    cloneStartedAt,
    cleanup,
  );
  const repo = new Repository(owner.store);
  let leaseExpiresAt = cloneStartedAt + PROVISIONAL_CLONE_LEASE_MS;
  const heartbeat = (): void => {
    const now = context.now();
    if (leaseExpiresAt - now > PROVISIONAL_CLONE_RENEW_WINDOW_MS) return;
    leaseExpiresAt = context.database.renewProvisionalClone(owner, now);
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

    const depth =
      options.depth !== undefined && options.depth > 0 && Number.isFinite(options.depth)
        ? options.depth
        : undefined;
    const singleBranch = options.singleBranch ?? depth !== undefined;
    const result = await fetchInto(
      context,
      repo,
      {
        remote,
        url,
        singleBranch,
        ...(options.noTags === true ? { tags: false } : singleBranch ? {} : { tags: true }),
        ...(options.ref === undefined ? {} : { ref: options.ref }),
        ...(depth === undefined ? {} : { depth }),
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
