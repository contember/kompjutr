import { GitError, hasErrorCode } from "../../common/errors.js";
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
import type { GitContext } from "../core/context.js";
import { type Repository, walkOwned } from "../repository/repository.js";
import { runFetchCheckpoint } from "./network-checkpoint.js";
import type { FetchConnectivity } from "./network-reachability.js";
import type { FetchCheckpointStage } from "./network-types.js";

const HAVE_BUDGET = 256;

function applyConnectivityShallow(
  connectivity: FetchConnectivity,
  response: { shallow: readonly string[]; unshallow: readonly string[] },
): void {
  for (const oid of response.unshallow) {
    connectivity.shallow.delete(oid);
    connectivity.unshallow.add(oid);
  }
  for (const oid of response.shallow) {
    connectivity.unshallow.delete(oid);
    connectivity.shallow.add(oid);
  }
}

/** Recent commits from the refs the fetch began with, as negotiation `have`s. */
function collectHaves(repo: Repository, tips: readonly string[]): string[] {
  const haves: string[] = [];
  const seen = new Set<string>();
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
  connectivity: FetchConnectivity | undefined,
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
    ...(connectivity === undefined
      ? {}
      : {
          connectivity: {
            reachability: connectivity.reachability,
            ...(connectivity.promisor === undefined ? {} : { promisor: connectivity.promisor }),
            shallow: [...connectivity.shallow],
            unshallow: [...connectivity.unshallow],
            acceptedPacks: [...connectivity.acceptedPacks],
          },
        }),
  };
  let packId: number;
  try {
    ({ packId } = await repo.store.packs.ingest(pack, ingestOptions));
  } catch (error) {
    if (hasErrorCode(error, "ENOTFOUND")) {
      throw new GitError("EFETCHFAIL", "fetched graph references a missing object", {
        cause: error,
      });
    }
    throw error;
  }
  connectivity?.acceptedPacks.push(packId);
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
    /** Every fetch supplies it; promisor hydration ingests unchecked. */
    connectivity?: FetchConnectivity;
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
        // Only commits the fetch can prove reachable may be offered; refs read now could have moved.
        ...(request.useLocalHaves === false
          ? []
          : collectHaves(repo, request.connectivity?.reachability?.tips ?? [])),
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
  if (request.connectivity !== undefined) applyConnectivityShallow(request.connectivity, result);
  await ingestPack(
    context,
    repo,
    fetchPackStream(result.pack, signal),
    say,
    checkpoint,
    request.connectivity,
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
