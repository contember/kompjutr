import { normalize } from "../../fs/path.js";
import { CHUNK_SIZE } from "../../fs/schema.js";
import { MAX_HANDLE_MATERIALIZE_BYTES } from "../../fs/store/read.js";
import type { HandleReadBatch, ReadBatch, RealPath, RegularFileHandle } from "../../fs/types.js";
import type { Worktree, WorktreeStat } from "../../git/ops/worktree.js";

const MAX_HANDLE_COUNT = 5_000;

function validateHandleInputs(handles: readonly RegularFileHandle[]): void {
  if (handles.length > MAX_HANDLE_COUNT) {
    throw new Error(`readFileHandles: at most ${MAX_HANDLE_COUNT} handles may be read at once`);
  }
  for (let index = 0; index < handles.length; index++) {
    const handle = handles[index];
    if (handle === undefined) continue;
    if (
      typeof handle.path !== "string" ||
      !handle.path.startsWith("/") ||
      normalize(handle.path) !== handle.path
    ) {
      throw new Error(`readFileHandles: handle ${index} has an invalid canonical path`);
    }
    if (
      !Number.isSafeInteger(handle.ino) ||
      !Number.isSafeInteger(handle.size) ||
      handle.size < 0 ||
      !Number.isSafeInteger(handle.rev)
    ) {
      throw new Error(`readFileHandles: handle ${index} has invalid metadata`);
    }
  }
}

function appendRemaining(
  out: RegularFileHandle[],
  handles: readonly RegularFileHandle[],
  from: number,
): void {
  for (let index = from; index < handles.length; index++) {
    const handle = handles[index];
    if (handle !== undefined) out.push(handle);
  }
}

export function readFileHandleBatch(
  worktree: Worktree,
  handles: readonly RegularFileHandle[],
  options: { budget?: number } = {},
): HandleReadBatch {
  const budget = options.budget ?? 1_500_000;
  if (!(budget > 0)) throw new Error("readFileHandles: budget must be positive");
  if (budget > 1_500_000) {
    throw new Error("readFileHandles: budget must not exceed 1500000 bytes");
  }
  validateHandleInputs(handles);
  const files = new Map<RealPath, Uint8Array>();
  const remaining: RegularFileHandle[] = [];
  const pending: RegularFileHandle[] = [];
  let plannedBytes = 0;
  for (let index = 0; index < handles.length; index++) {
    const handle = handles[index];
    if (handle === undefined) continue;
    if (pending.length > 0 && plannedBytes + handle.size > budget) {
      appendRemaining(remaining, handles, index);
      break;
    }
    pending.push(handle);
    plannedBytes += handle.size;
    if (handle.size > budget) {
      appendRemaining(remaining, handles, index + 1);
      break;
    }
  }

  const stats = new Map<RealPath, WorktreeStat>();
  for (const handle of pending) {
    const stat = worktree.stat(handle.path);
    if (
      stat?.type !== "file" ||
      stat.ino !== handle.ino ||
      stat.size !== handle.size ||
      stat.mtime !== handle.rev
    ) {
      throw Object.assign(new Error(`ESTALE: file handle is stale, '${handle.path}'`), {
        code: "ESTALE",
      });
    }
    if (stat.size > MAX_HANDLE_MATERIALIZE_BYTES) {
      throw Object.assign(
        new Error(
          `EFBIG: '${handle.path}' is ${stat.size} bytes; handle reads are capped at ${MAX_HANDLE_MATERIALIZE_BYTES}`,
        ),
        { code: "EFBIG" },
      );
    }
    stats.set(handle.path, stat);
  }

  for (const handle of pending) {
    const stat = stats.get(handle.path);
    if (stat === undefined) throw new Error(`validated stat missing for '${handle.path}'`);
    const contents = new Uint8Array(stat.size);
    for (let offset = 0; offset < stat.size; offset += CHUNK_SIZE) {
      const length = Math.min(CHUNK_SIZE, stat.size - offset);
      const chunk = worktree.readRange(handle.path, offset, length);
      if (chunk.length !== length) {
        throw Object.assign(new Error(`EIO: short read for '${handle.path}' at ${offset}`), {
          code: "EIO",
        });
      }
      contents.set(chunk, offset);
    }
    const after = worktree.stat(handle.path);
    if (
      after?.type !== "file" ||
      after.ino !== handle.ino ||
      after.size !== stat.size ||
      after.mtime !== handle.rev
    ) {
      throw Object.assign(new Error(`ESTALE: file handle is stale, '${handle.path}'`), {
        code: "ESTALE",
      });
    }
    files.set(handle.path, contents);
  }
  return { files, remaining };
}

export function readPathBatch(
  worktree: Worktree,
  paths: readonly string[],
  options: { budget?: number } = {},
): ReadBatch {
  const budget = options.budget ?? 1_500_000;
  const files = new Map<string, Uint8Array>();
  const remaining: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const stat = worktree.stat(path);
    if (stat?.type !== "file") continue;
    if (files.size > 0 && bytes + stat.size > budget) {
      remaining.push(path);
      continue;
    }
    const contents = worktree.readFile(path);
    files.set(path, contents);
    bytes += contents.byteLength;
  }
  return { files, remaining };
}
