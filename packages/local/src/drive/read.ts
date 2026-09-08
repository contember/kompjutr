import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  type Stats,
} from "node:fs";

import type {
  HandleReadBatch,
  ReadBatch,
  ReadOptions,
  RealPath,
  RegularFileHandle,
  Stat,
} from "@kompjutr/drive";
import { errorCode, localError, normalizeHostError } from "../errors.js";
import type { PathMapper } from "../paths.js";

const DEFAULT_READ_BUDGET = 1_500_000;
const MAX_MATERIALIZED_BYTES = 32 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;
const linkDecoder = new TextDecoder("utf-8", { fatal: true });

function safeInode(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function statAt(host: string, revision: number): Stat | null {
  let value: Stats;
  try {
    value = lstatSync(host);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    normalizeHostError(error, "lstat", host);
  }
  let type: Stat["type"];
  let target: string | null = null;
  let size = value.size;
  if (value.isFile()) type = "file";
  else if (value.isDirectory()) type = "dir";
  else if (value.isSymbolicLink()) {
    type = "symlink";
    let bytes: Buffer;
    try {
      bytes = readlinkSync(host, { encoding: "buffer" });
    } catch (error) {
      normalizeHostError(error, "readlink", host);
    }
    try {
      target = linkDecoder.decode(bytes);
    } catch {
      throw localError("EILSEQ", "symbolic link target is not valid UTF-8", host);
    }
    size = bytes.length;
  } else {
    return null;
  }
  return {
    type,
    mode: value.mode,
    size,
    mtime: Math.trunc(value.mtimeMs),
    ino: safeInode(value.ino),
    nlink: value.nlink,
    rev: revision,
    target,
    contentId: null,
  };
}

export function readFileAt(mapper: PathMapper, path: string): Uint8Array {
  const host = mapper.host(path, true);
  let fd: number | undefined;
  try {
    fd = openSync(host, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile()) throw localError("EISDIR", "path is not a regular file", path);
    return readOpenedFile(fd, path, before);
  } catch (error) {
    normalizeHostError(error, "read file", path);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  throw localError("EIO", "read file failed", path);
}

export function readRangeAt(
  mapper: PathMapper,
  path: string,
  offset: number,
  length: number,
): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw localError("EINVAL", "read range requires safe nonnegative offset and length", path);
  }
  const host = mapper.host(path, true);
  const fd = openSync(host, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const count = readSync(fd, bytes, filled, length - filled, offset + filled);
      if (count === 0) break;
      filled += count;
    }
    return filled === length ? bytes : bytes.slice(0, filled);
  } finally {
    closeSync(fd);
  }
}

function openedFileMatches(value: Stats, expected: Stat): boolean {
  return (
    value.isFile() &&
    value.size === expected.size &&
    Math.trunc(value.mtimeMs) === expected.mtime &&
    safeInode(value.ino) === expected.ino &&
    value.mode === expected.mode &&
    value.nlink === expected.nlink
  );
}

export function* readFileStreamAt(
  mapper: PathMapper,
  path: string,
  expected: Stat,
): Generator<Uint8Array> {
  const host = mapper.host(path, true);
  const fd = openSync(host, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!openedFileMatches(before, expected)) {
      throw localError("ESTALE", "file changed before streaming read", path);
    }
    let offset = 0;
    while (offset < before.size) {
      const bytes = new Uint8Array(Math.min(STREAM_CHUNK_BYTES, before.size - offset));
      const count = readSync(fd, bytes, 0, bytes.length, offset);
      if (count === 0) break;
      offset += count;
      yield count === bytes.length ? bytes : bytes.slice(0, count);
    }
    const after = fstatSync(fd);
    if (
      offset !== before.size ||
      safeInode(after.ino) !== safeInode(before.ino) ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw localError("ESTALE", "file changed during streaming read", path);
    }
  } finally {
    closeSync(fd);
  }
}

function validateReadOptions(options: ReadOptions): { budget: number; maxBytes: number } {
  const budget = options.budget ?? DEFAULT_READ_BUDGET;
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(budget) || budget < 1)
    throw localError("EINVAL", "read budget must be positive");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw localError("EINVAL", "read maxBytes must be a positive safe integer");
  }
  return { budget, maxBytes };
}

export function readFilesAt(
  mapper: PathMapper,
  paths: readonly string[],
  options: ReadOptions = {},
): ReadBatch {
  const { budget, maxBytes } = validateReadOptions(options);
  const files = new Map<string, Uint8Array>();
  let selected = 0;
  let stopped = paths.length;
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    if (path === undefined) continue;
    const host = mapper.host(path, false);
    let fd: number;
    try {
      fd = openSync(host, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP") continue;
      normalizeHostError(error, "open file", path);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) continue;
      if (selected + stat.size > maxBytes) {
        stopped = index;
        break;
      }
      if (stat.size > budget && options.deferOversized === true) {
        stopped = index;
        break;
      }
      if (selected > 0 && selected + stat.size > budget) {
        stopped = index;
        break;
      }
      files.set(path, readOpenedFile(fd, path, stat));
      selected += stat.size;
    } finally {
      closeSync(fd);
    }
  }
  return { files, remaining: paths.slice(stopped) };
}

function readOpenedFile(fd: number, path: string, before: Stats): Uint8Array {
  if (!Number.isSafeInteger(before.size) || before.size < 0) {
    throw localError("E2BIG", "file size is invalid", path);
  }
  const bytes = new Uint8Array(before.size);
  let filled = 0;
  while (filled < bytes.length) {
    const count = readSync(fd, bytes, filled, bytes.length - filled, filled);
    if (count === 0) break;
    filled += count;
  }
  const after = fstatSync(fd);
  if (
    filled !== before.size ||
    safeInode(after.ino) !== safeInode(before.ino) ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw localError("ESTALE", "file changed during read", path);
  }
  return bytes;
}

function readHandle(mapper: PathMapper, handle: RegularFileHandle): Uint8Array {
  const canonical = mapper.resolve(handle.path, true);
  if (canonical !== handle.path) {
    throw localError("ESTALE", "file handle path changed before read", handle.path);
  }
  const host = mapper.lexicalHost(handle.path);
  const fd = openSync(host, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || safeInode(before.ino) !== handle.ino || before.size !== handle.size) {
      throw localError("ESTALE", "file handle changed before read", handle.path);
    }
    return readOpenedFile(fd, handle.path, before);
  } finally {
    closeSync(fd);
  }
}

export function readHandlesAt(
  mapper: PathMapper,
  handles: readonly RegularFileHandle[],
  options: { budget?: number } = {},
): HandleReadBatch {
  const budget = options.budget ?? DEFAULT_READ_BUDGET;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > DEFAULT_READ_BUDGET) {
    throw localError("EINVAL", "handle read budget is invalid");
  }
  let bytes = 0;
  let stopped = handles.length;
  for (let index = 0; index < handles.length; index++) {
    const handle = handles[index];
    if (handle === undefined) continue;
    if (!Number.isSafeInteger(handle.ino) || handle.ino < 0) {
      throw localError("EINVAL", "file handle inode is invalid", handle.path);
    }
    if (!Number.isSafeInteger(handle.size) || handle.size < 0) {
      throw localError("EINVAL", "file handle size is invalid", handle.path);
    }
    if (!Number.isSafeInteger(handle.rev) || handle.rev < 1) {
      throw localError("EINVAL", "file handle revision is invalid", handle.path);
    }
    if (handle.size > MAX_MATERIALIZED_BYTES) {
      throw localError("E2BIG", "file handle exceeds the materialization limit", handle.path);
    }
    if (bytes > 0 && bytes + handle.size > budget) {
      stopped = index;
      break;
    }
    if (bytes + handle.size > MAX_MATERIALIZED_BYTES) {
      stopped = index;
      break;
    }
    bytes += handle.size;
  }
  const selected = handles.slice(0, stopped);
  const validated = selected.map((handle) => ({ handle, bytes: readHandle(mapper, handle) }));
  const files = new Map<RealPath, Uint8Array>();
  for (const item of validated) files.set(item.handle.path, item.bytes);
  return { files, remaining: handles.slice(stopped) };
}
