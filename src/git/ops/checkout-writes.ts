// Shared bounded blob writes for full and sparse checkout paths.

import { fromHex } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { joinPath } from "../common/paths.js";
import type { BlobIdMapping, IndexEntry, IndexSink } from "../store/index.js";
import type { Repository } from "./repository.js";
import type { TargetEntry } from "./tree-stream.js";
import { fileModeFor, type Worktree } from "./worktree.js";

const CHECKOUT_BLOB_BYTES = 3 * 1024 * 1024;
const textDecoder = new TextDecoder();

export interface CheckoutWriteBudget {
  maxBytes: number;
  writtenBytes: number;
}

export function flushCheckoutWrites(
  repo: Repository,
  worktree: Worktree,
  entries: TargetEntry[],
  sink: IndexSink,
  budget?: CheckoutWriteBudget,
): void {
  if (entries.length === 0) return;
  let pending = entries.splice(0, entries.length);
  while (pending.length > 0) {
    const blobs = repo.readBlobs(
      pending.map((entry) => entry.oid),
      { budgetBytes: CHECKOUT_BLOB_BYTES },
    ).blobs;
    const writes = [];
    const indexEntries: IndexEntry[] = [];
    const mappings: BlobIdMapping[] = [];
    const deferred: TargetEntry[] = [];
    for (const entry of pending) {
      const data = blobs.get(entry.oid);
      if (data === undefined) {
        deferred.push(entry);
        continue;
      }
      if (budget !== undefined) {
        if (data.length > budget.maxBytes - budget.writtenBytes) {
          throw new GitError("E2BIG", `checkout writes exceed ${budget.maxBytes} bytes`);
        }
        budget.writtenBytes += data.length;
      }
      const contentId = fromHex(entry.oid);
      const absolute = joinPath(repo.root, entry.path);
      writes.push(
        entry.mode === "120000"
          ? { path: absolute, target: textDecoder.decode(data), contentId }
          : { path: absolute, bytes: data, mode: fileModeFor(entry.mode), contentId },
      );
      indexEntries.push({
        path: entry.path,
        stage: 0,
        mode: Number.parseInt(entry.mode, 8),
        oid: entry.oid,
        size: data.length,
        mtime: null,
        ino: null,
      });
      mappings.push({ contentId, oid: entry.oid });
    }
    worktree.writeFiles(writes);
    repo.store.upsertBlobIds(mappings);
    for (const entry of indexEntries) {
      sink.remove(entry.path);
      sink.put(entry);
    }
    sink.flush();
    if (deferred.length === pending.length) {
      throw new CorruptError("checkout blob batch made no progress");
    }
    pending = deferred;
  }
}
