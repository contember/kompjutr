import type { WriteEntry } from "../../../fs/types.js";
import { fromHex, utf8Decoder } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import { MODE_SYMLINK } from "../../common/objects.js";
import { joinPath } from "../../common/paths.js";
import { comparePaths } from "../../common/streams.js";
import { PACK_BLOB_BATCH_TARGET_BYTES } from "../../store/index.js";
import { writeObjectsOwned } from "../../store/repository/shared.js";
import type { Repository } from "../repository/repository.js";
import { fileModeFor, type Worktree, type WorktreeStat } from "../worktree/worktree.js";
import type { AdmittedBlobBatch, BlobMetadata, ContentObjects } from "./merge-apply-types.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import type { MergeTouchedPath } from "./merge-state.js";

const OBJECT_INFO_PAGE = 4_096;

export function collectBlobMetadata<T>(
  repo: Repository,
  entries: readonly T[],
  oidOf: (entry: T) => string | null,
  label: "merge output" | "merge abort",
): BlobMetadata {
  const seen = new Set<string>();
  const oids: string[] = [];
  for (const entry of entries) {
    const oid = oidOf(entry);
    if (oid === null || seen.has(oid)) continue;
    seen.add(oid);
    oids.push(oid);
  }

  const sizes = new Map<string, number>();
  for (let offset = 0; offset < oids.length; offset += OBJECT_INFO_PAGE) {
    const page = oids.slice(offset, offset + OBJECT_INFO_PAGE);
    for (const object of repo.store.objectInfo(page)) {
      if (object.type !== "blob") {
        throw new CorruptError(`${label} object ${object.oid} is not a blob`);
      }
      sizes.set(object.oid, object.size);
    }
  }
  for (const oid of oids) {
    if (!sizes.has(oid)) throw new CorruptError(`${label} lost object ${oid}`);
  }
  return { sizes };
}

export function validateSourceBlobs(
  repo: Repository,
  entries: readonly ProjectedMergeEntry[],
): BlobMetadata {
  return collectBlobMetadata(
    repo,
    entries,
    (entry) => (entry.content === null ? (entry.worktree?.oid ?? null) : null),
    "merge output",
  );
}

function readAdmittedBlobBatch<T>(
  repo: Repository,
  entries: readonly T[],
  start: number,
  metadata: BlobMetadata,
  oidOf: (entry: T) => string,
  label: string,
): AdmittedBlobBatch {
  let end = start;
  let payloadBytes = 0;
  const selected = new Set<string>();
  while (end < entries.length) {
    const entry = entries[end];
    if (entry === undefined) throw new CorruptError(`${label} selection is incomplete`);
    const oid = oidOf(entry);
    const size = metadata.sizes.get(oid);
    if (size === undefined) throw new CorruptError(`${label} lost object ${oid}`);
    const nextPayload = selected.has(oid) ? payloadBytes : payloadBytes + size;
    if (!Number.isSafeInteger(nextPayload)) throw new CorruptError(`${label} payload is invalid`);
    if (nextPayload > PACK_BLOB_BATCH_TARGET_BYTES && end > start) break;
    const nextOids = selected.has(oid) ? selected.size : selected.size + 1;
    if (nextOids > OBJECT_INFO_PAGE && end > start) break;
    selected.add(oid);
    payloadBytes = nextPayload;
    end++;
  }
  if (end === start) throw new CorruptError(`${label} made no progress`);
  const oids = [...selected];
  const read = repo.readBlobs(oids, { budgetBytes: Math.max(1, payloadBytes) });
  let actualPayloadBytes = 0;
  let returnedOids = 0;
  for (let index = 0; index < oids.length; index++) {
    const oid = oids[index];
    if (oid === undefined) throw new CorruptError(`${label} admitted object list is incomplete`);
    const bytes = read.blobs.get(oid);
    if (bytes === undefined) break;
    const expectedSize = metadata.sizes.get(oid);
    if (expectedSize === undefined || bytes.byteLength !== expectedSize) {
      throw new CorruptError(`${label} object ${oid} differs from its admitted metadata`);
    }
    actualPayloadBytes += bytes.byteLength;
    returnedOids++;
  }
  if (
    returnedOids === 0 ||
    read.blobs.size !== returnedOids ||
    read.remaining.length !== oids.length - returnedOids ||
    read.bytes !== actualPayloadBytes
  ) {
    throw new CorruptError(`${label} did not match its admitted payload`);
  }
  for (let index = returnedOids; index < oids.length; index++) {
    if (read.remaining[index - returnedOids] !== oids[index]) {
      throw new CorruptError(`${label} deferred a non-prefix object`);
    }
  }
  let actualEnd = start;
  while (actualEnd < end) {
    const entry = entries[actualEnd];
    if (entry === undefined || !read.blobs.has(oidOf(entry))) break;
    actualEnd++;
  }
  if (actualEnd === start) throw new CorruptError(`${label} made no progress`);
  return { end: actualEnd, blobs: read.blobs };
}

export function contentObjects(
  repo: Repository,
  entries: readonly ProjectedMergeEntry[],
): ContentObjects {
  const oids = new Map<string, string>();
  writeObjectsOwned(repo.store, (batch) => {
    for (const entry of entries) {
      if (entry.content === null) continue;
      const oid = batch.write("blob", entry.content);
      if (entry.stageZero !== null && oid !== entry.stageZero.oid) {
        throw new CorruptError(`merged content identity does not match ${entry.path}`);
      }
      oids.set(entry.path, oid);
    }
  });
  return { entries: oids };
}

export function materialiseWrites(
  repo: Repository,
  worktree: Worktree,
  entries: readonly ProjectedMergeEntry[],
  contentOids: ReadonlyMap<string, string>,
  metadata: BlobMetadata,
): void {
  const inline: WriteEntry[] = [];
  const pending: ProjectedMergeEntry[] = [];
  for (const entry of entries) {
    if (entry.worktree === null) continue;
    if (entry.content !== null) {
      const oid = contentOids.get(entry.path);
      if (oid === undefined) throw new CorruptError(`merge output lacks content ${entry.path}`);
      inline.push({
        path: joinPath(repo.root, entry.path),
        bytes: entry.content,
        mode: fileModeFor(entry.worktree.mode),
        contentId: fromHex(oid),
      });
    } else {
      pending.push(entry);
    }
  }
  if (inline.length > 0) {
    worktree.writeFiles(inline);
  }

  let offset = 0;
  while (offset < pending.length) {
    const batch = readAdmittedBlobBatch(
      repo,
      pending,
      offset,
      metadata,
      (entry) => entry.worktree?.oid ?? "",
      "merge output batch",
    );
    const writes: WriteEntry[] = [];
    for (let index = offset; index < batch.end; index++) {
      const entry = pending[index];
      if (entry === undefined) throw new CorruptError("merge output batch selection is incomplete");
      const identity = entry.worktree;
      if (identity === null) continue;
      const bytes = batch.blobs.get(identity.oid);
      if (bytes === undefined) throw new CorruptError(`merge output lost object ${identity.oid}`);
      const path = joinPath(repo.root, entry.path);
      const contentId = fromHex(identity.oid);
      writes.push(
        identity.mode === MODE_SYMLINK
          ? { path, target: utf8Decoder.decode(bytes), contentId }
          : { path, bytes, mode: fileModeFor(identity.mode), contentId },
      );
    }
    if (writes.length > 0) worktree.writeFiles(writes);
    offset = batch.end;
  }
}
export function restoreWorktree(
  repo: Repository,
  worktree: Worktree,
  touched: readonly MergeTouchedPath[],
  current: ReadonlyMap<string, WorktreeStat>,
  metadata: BlobMetadata,
): void {
  const removals = new Set<string>();
  const directories: WriteEntry[] = [];
  const pending: MergeTouchedPath[] = [];
  const addRemoval = (path: string): void => {
    if (removals.has(path)) return;
    removals.add(path);
  };
  for (const entry of touched) {
    if (entry.worktree.kind === "absent") {
      addRemoval(entry.path);
    } else if (entry.worktree.kind === "directory") {
      const found = current.get(entry.path);
      if (found !== undefined && found.type !== "dir") addRemoval(entry.path);
      directories.push({
        path: joinPath(repo.root, entry.path),
        mode: entry.worktree.mode & 0o7777,
      });
    } else {
      if (current.get(entry.path)?.type === "dir") addRemoval(entry.path);
      pending.push(entry);
    }
  }
  if (removals.size > 0) {
    const ordered = [...removals].sort(comparePaths);
    const absolute = ordered.map((path) => joinPath(repo.root, path));
    worktree.removeFiles(absolute, { recursive: true });
  }
  if (directories.length > 0) worktree.writeFiles(directories);

  let offset = 0;
  while (offset < pending.length) {
    const batch = readAdmittedBlobBatch(
      repo,
      pending,
      offset,
      metadata,
      (entry) =>
        entry.worktree.kind === "file" || entry.worktree.kind === "symlink"
          ? entry.worktree.oid
          : "",
      "merge restore batch",
    );
    const writes: WriteEntry[] = [];
    for (let index = offset; index < batch.end; index++) {
      const entry = pending[index];
      if (entry === undefined) throw new CorruptError("merge restore selection is incomplete");
      const snapshot = entry.worktree;
      if (snapshot.kind !== "file" && snapshot.kind !== "symlink") continue;
      const bytes = batch.blobs.get(snapshot.oid);
      if (bytes === undefined) throw new CorruptError(`merge abort lost object ${snapshot.oid}`);
      const path = joinPath(repo.root, entry.path);
      writes.push(
        snapshot.kind === "symlink"
          ? { path, target: utf8Decoder.decode(bytes), contentId: fromHex(snapshot.oid) }
          : {
              path,
              bytes,
              mode: snapshot.mode & 0o7777,
              contentId: fromHex(snapshot.oid),
            },
      );
    }
    if (writes.length > 0) worktree.writeFiles(writes);
    offset = batch.end;
  }
}
