import { isOid } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import {
  type MessageCallback,
  type ProgressCallback,
  progressSink,
} from "../../protocol/progress.js";
import {
  type Advertisement,
  discover,
  type UploadPackFilter,
  uploadPack,
} from "../../protocol/remote.js";
import { throwIfAborted } from "../../protocol/stream.js";
import { sharedRepoStoreMutations } from "../../store/repository/shared.js";
import type { GitContext } from "../core/context.js";
import { type Repository, walkOwned } from "../repository/repository.js";
import { runFetchCheckpoint } from "./network-checkpoint.js";
import type { FetchCheckpointStage } from "./network-types.js";

const HAVE_BUDGET = 256;

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
  promisor: { remote: string; url: string } | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const yieldNow =
    checkpoint === undefined
      ? context.yieldNow
      : async (): Promise<void> => {
          await runFetchCheckpoint(checkpoint, "pack-ingest", signal);
        };
  const ingestOptions = {
    ...(say === undefined ? {} : { onProgress: say }),
    now: context.now,
    ...(yieldNow === undefined ? {} : { yieldNow }),
    ...(signal === undefined ? {} : { signal }),
    ...(promisor === undefined
      ? {}
      : {
          lifecycle: {
            reserved() {},
            published(result: { readonly packId: number }) {
              recordPartialFetch(repo, promisor.remote, promisor.url, result.packId);
            },
          },
        }),
  };
  await repo.store.packs.ingest(pack, ingestOptions);
}

export async function transferPack(
  context: GitContext,
  repo: Repository,
  request: {
    url: string;
    wants: string[];
    shallows: string[];
    depth?: number;
    deepenRelative?: boolean;
    includeTag?: boolean;
    filter?: UploadPackFilter;
    thinPack?: boolean;
    promisorRemote?: string;
    advertised: Set<string>;
    haves?: string[];
    useLocalHaves?: boolean;
  },
  auth: NonNullable<Parameters<typeof uploadPack>[1]>,
  say: ((text: string) => void) | undefined,
  checkpoint: ((stage: FetchCheckpointStage) => Promise<void> | undefined) | undefined,
): Promise<{ shallow: string[]; unshallow: string[] }> {
  const signal = auth.signal;
  throwIfAborted(signal);
  if (request.wants.length === 0) return { shallow: [], unshallow: [] };
  await runFetchCheckpoint(checkpoint, "before-upload", signal);
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
        ...(request.deepenRelative === undefined ? {} : { deepenRelative: request.deepenRelative }),
        ...(request.includeTag === undefined ? {} : { includeTag: request.includeTag }),
        ...(request.filter === undefined ? {} : { filter: request.filter }),
        ...(request.thinPack === undefined ? {} : { thinPack: request.thinPack }),
        ...(say === undefined ? {} : { onProgress: say, onMessage: say }),
      },
      auth,
    );
  } catch (error) {
    throwIfAborted(signal);
    if (isPublicFetchNetworkError(error)) throw error;
    throw new GitError("EHTTP", "upload-pack request failed", { cause: error });
  }
  await runFetchCheckpoint(checkpoint, "before-ingest", signal);
  await ingestPack(
    context,
    repo,
    fetchPackStream(result.pack, signal),
    say,
    checkpoint,
    request.promisorRemote === undefined
      ? undefined
      : { remote: request.promisorRemote, url: request.url },
    signal,
  );
  await runFetchCheckpoint(checkpoint, "after-ingest", signal);
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    await runFetchCheckpoint(checkpoint, "after-shallow-response", signal);
  }
  return { shallow: result.shallow, unshallow: result.unshallow };
}

async function* fetchPackStream(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of source) {
      throwIfAborted(signal);
      yield chunk;
    }
    throwIfAborted(signal);
  } catch (error) {
    throwIfAborted(signal);
    if (isPublicFetchNetworkError(error)) throw error;
    throw new GitError("EHTTP", "upload-pack response stream failed", { cause: error });
  }
}

function recordPartialFetch(repo: Repository, remote: string, url: string, packId: number): void {
  sharedRepoStoreMutations(repo.store).registerPromisorRemoteOwned(remote, url);
  sharedRepoStoreMutations(repo.store).addPromisedBlobsFromPackTreesOwned(remote, packId);
}

export function fetchProgressSink(
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
    error.code === "EUNSUPPORTED" ||
    error.code === "EURLSCHEME"
  );
}

export async function fetchAdvertisement(
  url: string,
  auth: NonNullable<Parameters<typeof discover>[2]>,
): Promise<Advertisement> {
  try {
    return await discover(url, "git-upload-pack", auth);
  } catch (error) {
    throwIfAborted(auth.signal);
    if (isPublicFetchNetworkError(error)) throw error;
    throw new GitError("EHTTP", "upload-pack discovery request failed", { cause: error });
  }
}
