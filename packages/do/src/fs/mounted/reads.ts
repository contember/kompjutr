// Single-path and batched reads through a mounted view.
//
// Inside a mount each call is the store's own: one confined resolution, then
// the same statements. A synthetic directory answers from the mount table and
// an absent path from nothing, so neither can reveal what the store holds
// outside the mounts.

import { filesystemError, hasErrorCode } from "../errors.js";
import { normalize } from "../path.js";
import { readResolvedFiles } from "../store/read/read-resolved.js";
import { readFileHandles as storeReadFileHandles } from "../store/read.js";
import { resolveManyWithin, resolveWithin, unstoredRealPath } from "../store/resolve.js";
import type {
  Dirent,
  HandleReadBatch,
  ReadBatch,
  ReadOptions,
  RealPath,
  RegularFileHandle,
  Stat,
} from "../types.js";
import { missing, type ViewContext } from "./context.js";
import { realRealPath, virtualRealPath } from "./items.js";
import type { Mount } from "./mounts.js";

export function realpathOf(context: ViewContext, path: string): RealPath {
  const location = context.locate(path);
  if (location.kind === "synthetic") return unstoredRealPath(location.path);
  if (location.kind === "absent") return unstoredRealPath(normalize(path));
  const { mount } = location;
  const real = context.translating([mount], () =>
    resolveWithin(context.db, mount.source, location.real, true, mount.top),
  );
  if (typeof real !== "string") throw missing(path);
  return virtualRealPath(mount, real);
}

/** `stat` (lstat) or `statTarget`. A path that would leave its mount is absent. */
export function statOf(context: ViewContext, path: string, follow: boolean): Stat | null {
  const location = context.locate(path);
  if (location.kind === "synthetic") return context.table.syntheticStat(location.path);
  if (location.kind === "absent") return null;
  const { mount, real } = location;
  const ops = context.ops(mount);
  try {
    return context.translating([mount], () => (follow ? ops.statTarget(real) : ops.stat(real)));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** The mount and real path of a path that must exist inside one. */
function inside(
  context: ViewContext,
  path: string,
  synthetic: () => Error,
): { mount: Mount; real: string } {
  const location = context.locate(path);
  if (location.kind === "synthetic") throw synthetic();
  if (location.kind === "absent") throw missing(path);
  return location;
}

const isDirectory = (path: string) => () =>
  filesystemError("EISDIR", "illegal operation on a directory", path);

export function readFileOf(context: ViewContext, path: string): Uint8Array {
  const { mount, real } = inside(context, path, isDirectory(path));
  return context.translating([mount], () => context.ops(mount).readFile(real));
}

export function readRangeOf(
  context: ViewContext,
  path: string,
  offset: number,
  length: number,
): Uint8Array {
  const { mount, real } = inside(context, path, isDirectory(path));
  return context.translating([mount], () => context.ops(mount).readRange(real, offset, length));
}

export function readlinkOf(context: ViewContext, path: string): string {
  const { mount, real } = inside(context, path, () =>
    filesystemError("EINVAL", "not a symbolic link", path),
  );
  return context.translating([mount], () => context.ops(mount).readlink(real));
}

export function readdirOf(context: ViewContext, path: string): Dirent[] {
  const location = context.locate(path);
  if (location.kind === "absent") throw missing(path);
  if (location.kind === "synthetic") {
    return context.table.childrenOf(location.path).map((child) => ({
      name: child.slice(child.lastIndexOf("/") + 1),
      type: "dir",
    }));
  }
  const { mount, real } = location;
  return context.translating([mount], () => context.ops(mount).readdir(real));
}

/** One batched, confined resolution for every path inside a mount. */
export function readFilesOf(
  context: ViewContext,
  paths: readonly string[],
  options?: ReadOptions,
): ReadBatch {
  const slots: (number | null)[] = [];
  const walks: { root: string; path: string; top: boolean }[] = [];
  const mounts: Mount[] = [];
  for (const path of paths) {
    const location = context.locate(path);
    if (location.kind !== "mount") {
      slots.push(null);
      continue;
    }
    slots.push(walks.length);
    walks.push({ root: location.mount.source, path: location.real, top: location.mount.top });
    mounts.push(location.mount);
  }
  return context.translating(mounts, () => {
    const found = resolveManyWithin(context.db, walks, true);
    const resolved = slots.map((slot) => {
      const real = slot === null ? undefined : found[slot];
      return typeof real === "string" ? real : null;
    });
    return readResolvedFiles(context.db, paths, resolved, options);
  });
}

export function readFileHandlesOf(
  context: ViewContext,
  handles: readonly RegularFileHandle[],
  options?: { budget?: number },
): HandleReadBatch {
  const real: RegularFileHandle[] = [];
  const originals = new Map<RegularFileHandle, RegularFileHandle>();
  const virtualPaths = new Map<RealPath, RealPath>();
  const mounts: Mount[] = [];
  for (let index = 0; index < handles.length; index++) {
    const handle = handles[index];
    if (handle === undefined) continue;
    if (typeof handle.path !== "string" || normalize(handle.path) !== handle.path) {
      throw new Error(`readFileHandles: handle ${index} has an invalid canonical path`);
    }
    const place = context.table.place(handle.path);
    if (place.kind !== "mount") {
      throw filesystemError("ESTALE", "file handle is stale", handle.path);
    }
    const path = realRealPath(place.mount, handle.path);
    const translated = { ...handle, path };
    real.push(translated);
    originals.set(translated, handle);
    if (!virtualPaths.has(path)) virtualPaths.set(path, handle.path);
    mounts.push(place.mount);
  }
  const batch = context.translating(mounts, () => storeReadFileHandles(context.db, real, options));
  const files = new Map<RealPath, Uint8Array>();
  for (const [path, bytes] of batch.files) files.set(virtualPaths.get(path) ?? path, bytes);
  return {
    files,
    remaining: batch.remaining.map((handle) => originals.get(handle) ?? handle),
  };
}
