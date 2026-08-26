// clone and fetch: ref discovery, one-round negotiation, streaming pack
// ingest, then a transactional ref update.
//
// The ordering is the crash-safety contract. The pack is written and
// verified while it is invisible to reads; only once it is complete do the
// refs move, in one transaction. An interrupted fetch leaves every
// existing ref valid and one reclaimable pending pack.

import { type InitialStateSession, MAX_BLOB_BATCH_BYTES } from "../../sqlite/store.js";
import { fromHex } from "../bytes.js";
import type { GitContext, IndexTrackerSeedEntry, InitialWorktreeSession } from "../context.js";
import { AlreadyInitializedError, CorruptError, GitError } from "../errors.js";
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
import { fileModeFor } from "../worktree.js";
import { checkoutTree } from "./checkout.js";
import { operationRefLogMetadata } from "./ref-log.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";

/** How many commits back from each local tip are offered as `have`s. */
const HAVE_BUDGET = 256;
const INITIAL_CLONE_WINDOW_ROWS = 1_000;
const INITIAL_CLONE_BLOB_BYTES = MAX_BLOB_BATCH_BYTES;
const INITIAL_CLONE_SMALL_FILE_BYTES = 1024 * 1024;
const INITIAL_CLONE_TRACKER_ROWS = 32_000;
const INITIAL_CLONE_TRACKER_BYTES = 4 * 1024 * 1024;
const INITIAL_CLONE_TRACKER_FIXED_BYTES = 64 * 1024;
const INITIAL_CLONE_TRACKER_ROW_BYTES = 128;
const INITIAL_CLONE_INDEX_DIRTY = 1;
const INITIAL_CLONE_READ_FALLBACK = Symbol("initial clone blob exceeds batch budget");
const initialCloneTextDecoder = new TextDecoder();

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

export function remoteUrlFor(repo: Repository, remote: string): string | undefined {
  return repo.store.configGet(`remote.${remote}.url`);
}

/** The remote refs a fetch should ask for. */
function selectRefs(
  advertisement: Advertisement,
  options: { ref?: string; singleBranch: boolean; tags: boolean },
): RemoteRef[] {
  const { refs } = advertisement;
  if (options.ref !== undefined) {
    const wanted = options.ref;
    const exact = refs.find((ref) => ref.name === wanted);
    if (exact !== undefined) return [exact];
    for (const prefix of ["refs/heads/", "refs/tags/", "refs/remotes/"]) {
      const found = refs.find((ref) => ref.name === `${prefix}${wanted}`);
      if (found !== undefined) return [found];
    }
    throw new GitError("EREFNOTFOUND", `couldn't find remote ref ${wanted}`);
  }
  if (options.singleBranch) {
    const head = advertisement.headRef;
    const branch = head === null ? undefined : refs.find((ref) => ref.name === head);
    if (branch !== undefined) return [branch];
    const fallback = refs.find((ref) => ref.name.startsWith("refs/heads/"));
    if (fallback === undefined) throw new GitError("EREFNOTFOUND", "remote has no branches");
    return [fallback];
  }
  return refs.filter(
    (ref) =>
      ref.name.startsWith("refs/heads/") ||
      (options.tags && ref.name.startsWith("refs/tags/") && !ref.name.endsWith("^{}")),
  );
}

/** Recent commits from every local ref, as negotiation `have`s. */
function collectHaves(repo: Repository): string[] {
  const haves: string[] = [];
  const seen = new Set<string>();
  const tips = repo.store.listRefs().map((ref) => ref.target);
  const head = repo.head().oid;
  if (head !== null) tips.unshift(head);
  for (const tip of tips) {
    if (!/^[0-9a-f]{40}$/.test(tip) || !repo.has(tip)) continue;
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

export async function fetchInto(
  context: GitContext,
  repo: Repository,
  options: FetchOptions,
  refLogReason: "fetch" | "clone: fetch" = "fetch",
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
  const wantedRefs = selectRefs(advertisement, {
    ...(requestedRef === undefined ? {} : { ref: requestedRef }),
    singleBranch: options.singleBranch ?? false,
    tags: options.tags ?? false,
  });

  const say = progressSink(options.onProgress, options.onMessage);
  const wants = [...new Set(wantedRefs.map((ref) => ref.oid))].filter((oid) => !repo.has(oid));
  const shallows = [...repo.shallow()];
  if (wants.length > 0) {
    const result = await uploadPack(
      {
        url,
        wants,
        haves: collectHaves(repo),
        shallows,
        advertised: advertisement.capabilities,
        ...(options.depth === undefined ? {} : { depth: options.depth }),
        ...(options.tags === true ? { includeTag: true } : {}),
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
  for (const ref of wantedRefs) {
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
  repo.store.mutateRefs(
    { puts: updates, deletes },
    operationRefLogMetadata(context, repo, refLogReason),
  );

  const first = wantedRefs[0];
  return {
    defaultBranch: advertisement.headRef,
    fetchHead: first === undefined ? null : first.oid,
  };
}

function directErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function readInitialCloneBlobs(repo: Repository, entries: readonly TargetEntry[]) {
  try {
    return repo.readBlobs(
      entries.map((entry) => entry.oid),
      { budgetBytes: INITIAL_CLONE_BLOB_BYTES },
    );
  } catch (error) {
    if (directErrorCode(error) === "EFBIG") throw INITIAL_CLONE_READ_FALLBACK;
    throw error;
  }
}

function writeInitialCloneEntry(
  worktree: InitialWorktreeSession,
  index: InitialStateSession,
  entry: TargetEntry,
  data: Uint8Array,
): void {
  const contentId = fromHex(entry.oid);
  if (entry.mode === "120000") {
    worktree.writeSymlink(entry.path, initialCloneTextDecoder.decode(data), { contentId });
  } else if (data.length <= INITIAL_CLONE_SMALL_FILE_BYTES) {
    worktree.writeFile(entry.path, data, { mode: fileModeFor(entry.mode), contentId });
  } else {
    worktree.writeFileStream(entry.path, data.length, [data], {
      mode: fileModeFor(entry.mode),
      contentId,
    });
  }
  index.put({
    path: entry.path,
    stage: 0,
    mode: Number.parseInt(entry.mode, 8),
    oid: entry.oid,
    size: data.length,
    mtime: null,
    ino: null,
  });
  index.addBlobId({ contentId, oid: entry.oid });
}

function flushInitialCloneWindow(
  repo: Repository,
  worktree: InitialWorktreeSession,
  index: InitialStateSession,
  window: TargetEntry[],
): void {
  let pending = window.splice(0, window.length);
  while (pending.length > 0) {
    const { blobs } = readInitialCloneBlobs(repo, pending);
    let processed = 0;
    while (processed < pending.length) {
      const entry = pending[processed]!;
      const data = blobs.get(entry.oid);
      if (data === undefined) break;
      writeInitialCloneEntry(worktree, index, entry, data);
      processed++;
    }
    if (processed === 0) throw new CorruptError("initial clone blob batch made no progress");
    pending = pending.slice(processed);
  }
}

function writeInitialClone(
  repo: Repository,
  treeOid: string,
  worktree: InitialWorktreeSession,
  index: InitialStateSession,
): IndexTrackerSeedEntry[] | null {
  const window: TargetEntry[] = [];
  let trackerSeed: IndexTrackerSeedEntry[] | null = [];
  let trackerSeedBytes = INITIAL_CLONE_TRACKER_FIXED_BYTES;
  for (const entry of treeStream(repo, treeOid)) {
    if (entry.mode === "160000") {
      if (trackerSeed !== null) {
        const retainedBytes = INITIAL_CLONE_TRACKER_ROW_BYTES + entry.path.length * 2;
        if (
          trackerSeed.length === INITIAL_CLONE_TRACKER_ROWS ||
          trackerSeedBytes > INITIAL_CLONE_TRACKER_BYTES - retainedBytes
        ) {
          trackerSeed = null;
        } else {
          trackerSeed.push({ path: entry.path, flags: INITIAL_CLONE_INDEX_DIRTY });
          trackerSeedBytes += retainedBytes;
        }
      }
      continue;
    }
    window.push(entry);
    if (window.length === INITIAL_CLONE_WINDOW_ROWS) {
      flushInitialCloneWindow(repo, worktree, index, window);
    }
  }
  flushInitialCloneWindow(repo, worktree, index, window);
  return trackerSeed;
}

function tryInitialClone(context: GitContext, repo: Repository, treeOid: string): boolean {
  const writer = context.initialWorktree;
  if (writer === undefined) return false;
  try {
    const worktree = writer.tryRun(
      repo.root,
      (worktreeSession) =>
        repo.store.tryCreateInitialState((indexSession) =>
          writeInitialClone(repo, treeOid, worktreeSession, indexSession),
        ),
      (state) => {
        if (state.available && state.value !== null && context.indexTracker !== undefined) {
          context.indexTracker.reseal(repo.store.checkoutId, treeOid, state.value);
        }
      },
    );
    return worktree.kind === "committed" && worktree.value.available;
  } catch (error) {
    if (error === INITIAL_CLONE_READ_FALLBACK) return false;
    throw error;
  }
}

export async function clone(context: GitContext, options: CloneOptions): Promise<void> {
  const root = normalizePath(options.dir ?? "/");
  if (context.database.at(root) !== null) throw new AlreadyInitializedError(root);
  const url = normalizeRemoteUrl(options.url);
  const remote = options.remote ?? "origin";

  const row = context.database.create(root, "ref: refs/heads/main");
  const repo = new Repository(context.database.open(row), row.root);
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
      repo.store.mutateRefs(
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
