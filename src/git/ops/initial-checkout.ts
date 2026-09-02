// Bounded create-only materialisation shared by clone and an eligible first
// standalone checkout. Publication stays with the caller.

import { fromHex } from "../common/bytes.js";
import { CorruptError } from "../common/errors.js";
import { checkoutStoreMutations } from "../store/checkout.js";
import { type InitialStateSession, PACK_BLOB_BATCH_TARGET_BYTES } from "../store/index.js";
import type { GitContext, IndexTrackerSeedEntry, InitialWorktreeSession } from "./context.js";
import type { Repository } from "./repository.js";
import { type TargetEntry, treeStream } from "./tree-stream.js";
import { fileModeFor } from "./worktree.js";

const INITIAL_WINDOW_ROWS = 1_000;
const INITIAL_BLOB_BYTES = PACK_BLOB_BATCH_TARGET_BYTES;
const INITIAL_SMALL_FILE_BYTES = 1024 * 1024;
const INITIAL_TRACKER_BYTES = 4 * 1024 * 1024;
const INITIAL_TRACKER_FIXED_BYTES = 64 * 1024;
const INITIAL_TRACKER_ROW_BYTES = 128;
const INITIAL_INDEX_DIRTY = 1;
const INITIAL_CHECKOUT_FALLBACK = Symbol("initial checkout requires ordinary materialisation");
const initialTextDecoder = new TextDecoder();

export interface InitialCheckoutOptions {
  /** Require proof that filesystem and Git writes share one synchronous transaction. */
  requireSharedDatabase?: boolean;
  /** Let standalone checkout retry ordinary materialisation after bounded capacity refusal. */
  fallbackOnCapacity?: boolean;
  /** Publish HEAD or other caller-owned state only after materialisation closes. */
  afterMaterialize?: () => void;
}

export function isInitialCheckoutFallback(error: unknown): boolean {
  return error === INITIAL_CHECKOUT_FALLBACK;
}

function directErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function readInitialBlobs(repo: Repository, entries: readonly TargetEntry[]) {
  return repo.readBlobs(
    entries.map((entry) => entry.oid),
    { budgetBytes: INITIAL_BLOB_BYTES },
  );
}

function writeInitialEntry(
  worktree: InitialWorktreeSession,
  index: InitialStateSession,
  entry: TargetEntry,
  data: Uint8Array,
): void {
  const contentId = fromHex(entry.oid);
  if (entry.mode === "120000") {
    worktree.writeSymlink(entry.path, initialTextDecoder.decode(data), { contentId });
  } else if (data.length <= INITIAL_SMALL_FILE_BYTES) {
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

function flushInitialWindow(
  repo: Repository,
  worktree: InitialWorktreeSession,
  index: InitialStateSession,
  window: TargetEntry[],
): void {
  let pending = window.splice(0, window.length);
  while (pending.length > 0) {
    const { blobs } = readInitialBlobs(repo, pending);
    let processed = 0;
    while (processed < pending.length) {
      const entry = pending[processed];
      if (entry === undefined) throw new CorruptError("initial checkout lost a pending entry");
      const data = blobs.get(entry.oid);
      if (data === undefined) break;
      writeInitialEntry(worktree, index, entry, data);
      processed++;
    }
    if (processed === 0) throw new CorruptError("initial checkout blob batch made no progress");
    pending = pending.slice(processed);
  }
}

function writeInitialCheckout(
  repo: Repository,
  treeOid: string,
  worktree: InitialWorktreeSession,
  index: InitialStateSession,
): IndexTrackerSeedEntry[] | null {
  const window: TargetEntry[] = [];
  let trackerSeed: IndexTrackerSeedEntry[] | null = [];
  let trackerSeedBytes = INITIAL_TRACKER_FIXED_BYTES;
  for (const entry of treeStream(repo, treeOid)) {
    if (entry.mode === "160000") {
      if (trackerSeed !== null) {
        const retainedBytes = INITIAL_TRACKER_ROW_BYTES + entry.path.length * 2;
        if (trackerSeedBytes > INITIAL_TRACKER_BYTES - retainedBytes) {
          trackerSeed = null;
        } else {
          trackerSeed.push({ path: entry.path, flags: INITIAL_INDEX_DIRTY });
          trackerSeedBytes += retainedBytes;
        }
      }
      continue;
    }
    window.push(entry);
    if (window.length === INITIAL_WINDOW_ROWS) {
      flushInitialWindow(repo, worktree, index, window);
    }
  }
  flushInitialWindow(repo, worktree, index, window);
  return trackerSeed;
}

/**
 * Materialise only while the writer and index can prove create-only state.
 * Capacity failures escape so an enclosing transaction can roll back before fallback.
 */
export function tryInitialCheckout(
  context: GitContext,
  repo: Repository,
  treeOid: string,
  options: InitialCheckoutOptions = {},
): boolean {
  const writer = context.initialWorktree;
  if (writer === undefined) return false;
  if (
    options.requireSharedDatabase === true &&
    writer.supportsDatabase?.(context.database) !== true
  ) {
    return false;
  }

  let publishing = false;
  try {
    const worktree = writer.tryRun(
      repo.root,
      (worktreeSession) =>
        checkoutStoreMutations(repo.checkout).tryCreateInitialStateOwned((indexSession) =>
          writeInitialCheckout(repo, treeOid, worktreeSession, indexSession),
        ),
      (state) => {
        if (!state.available) return;
        publishing = true;
        options.afterMaterialize?.();
        if (state.value !== null && context.indexTracker !== undefined) {
          context.indexTracker.reseal(repo.checkout.checkoutId, treeOid, state.value);
        }
      },
    );
    return worktree.kind === "committed" && worktree.value.available;
  } catch (error) {
    if (!publishing && options.fallbackOnCapacity === true && directErrorCode(error) === "E2BIG") {
      throw INITIAL_CHECKOUT_FALLBACK;
    }
    throw error;
  }
}
