// Mutations through a mounted view.
//
// Only a read-write mount accepts a write. A synthetic directory and a
// read-only mount answer EROFS, a mount root refuses removal and rename with
// EBUSY as a kernel mount point does, and rename or hard link across two
// mounts is EXDEV. A path the view does not show is ENOENT, or EROFS when
// creating it would write into a synthetic directory. Every check here is
// lexical, so a refusal costs no statement and reveals nothing stored.

import { filesystemError } from "../errors.js";
import { normalize } from "../path.js";
import { COPY_ENTRY_LIMIT, copyFiles as storeCopyFiles } from "../store/copy.js";
import { removeFiles as storeRemoveFiles } from "../store/remove.js";
import { type ConfinementBreach, resolveManyWithin, resolveWithin } from "../store/resolve.js";
import { writeFileStream as storeWriteStream } from "../store/stream-write.js";
import { touchFiles as storeTouchFiles, TOUCH_PATH_LIMIT } from "../store/touch.js";
import { writeFiles as storeWriteFiles } from "../store/write.js";
import type {
  CopyBatch,
  CopyEntry,
  CopyOptions,
  RealPath,
  RemoveOptions,
  StreamWriteOptions,
  TouchOptions,
  WriteEntry,
  WriteOptions,
} from "../types.js";
import { missing, readOnly, type ViewContext } from "./context.js";
import type { Location } from "./locate.js";
import type { Mount } from "./mounts.js";

/** What an absent target means for this call. */
type Absent =
  /** The call creates missing parents: it would write into a synthetic directory. */
  | "creates"
  /** The call needs the parent: EROFS when that is synthetic, ENOENT otherwise. */
  | "parent"
  /** The target itself must exist. */
  | "exists";

export interface Target {
  readonly mount: Mount;
  readonly real: string;
}

function absentError(location: Location & { kind: "absent" }, absent: Absent, path: string) {
  if (absent === "creates" || (absent === "parent" && location.parentSynthetic)) {
    return readOnly(path);
  }
  return missing(path);
}

/** A path inside a read-write mount, or the refusal for it. */
export function writable(
  context: ViewContext,
  path: string,
  absent: Absent,
  location: Location = context.locate(path),
): Target {
  if (location.kind === "synthetic") throw readOnly(path);
  if (location.kind === "absent") throw absentError(location, absent, path);
  if (location.mount.mode === "ro") throw readOnly(path);
  return location;
}

export function isMountRoot(target: Target): boolean {
  return normalize(target.real) === target.mount.source;
}

export function busy(path: string): Error {
  return filesystemError("EBUSY", "resource busy or locked", path);
}

export function crossDevice(path: string): Error {
  return filesystemError("EXDEV", "cross-device link not permitted", path);
}

function unwrap(resolved: RealPath | ConfinementBreach, path: string): RealPath {
  if (typeof resolved !== "string") throw missing(path);
  return resolved;
}

function mountsOf(targets: readonly Target[]): Mount[] {
  return [...new Set(targets.map((target) => target.mount))];
}

/** Resolve many targets in one confined batch. A breach is the caller's choice. */
function resolveTargets(
  context: ViewContext,
  targets: readonly Target[],
  followFinal: boolean,
): (RealPath | ConfinementBreach)[] {
  return resolveManyWithin(
    context.db,
    targets.map((target) => ({
      root: target.mount.source,
      path: target.real,
      top: target.mount.top,
    })),
    followFinal,
  );
}

function isDirectoryEntry(entry: WriteEntry): boolean {
  return entry.bytes === undefined && entry.target === undefined;
}

export function writeFilesOf(
  context: ViewContext,
  entries: readonly WriteEntry[],
  options: WriteOptions | undefined,
): void {
  const absent: Absent = options?.parents === false ? "parent" : "creates";
  const targets: Target[] = [];
  const real: WriteEntry[] = [];
  for (const entry of entries) {
    const location = context.locate(entry.path);
    // A synthetic directory already is the directory an entry may name.
    if (location.kind === "synthetic" && isDirectoryEntry(entry)) continue;
    const target = writable(context, entry.path, absent, location);
    targets.push(target);
    real.push({ ...entry, path: target.real });
  }
  if (real.length === 0) return;
  context.translating(mountsOf(targets), () =>
    storeWriteFiles(context.db, real, options, context.now, {
      realpathsNoFollow: (paths) =>
        resolveTargets(context, targets, false).map((resolved, index) =>
          unwrap(resolved, paths[index] ?? ""),
        ),
    }),
  );
}

export function copyFilesOf(
  context: ViewContext,
  entries: readonly CopyEntry[],
  options: CopyOptions | undefined,
): CopyBatch {
  const page = entries.slice(0, COPY_ENTRY_LIMIT);
  const sources: Target[] = [];
  const destinations: Target[] = [];
  for (const entry of page) {
    const location = context.locate(entry.source);
    if (location.kind === "absent") throw missing(entry.source);
    if (location.kind === "synthetic") {
      throw filesystemError("EPERM", "cannot copy a synthetic directory", entry.source);
    }
    sources.push(location);
    destinations.push(
      writable(context, entry.destination, options?.parents === true ? "creates" : "parent"),
    );
  }
  const copied = context.translating(mountsOf([...sources, ...destinations]), () => {
    const realSources = resolveTargets(context, sources, false);
    const realDestinations = resolveTargets(context, destinations, false);
    const resolved = page.map((entry, index) => ({
      source: unwrap(realSources[index] ?? { breach: "outside" }, entry.source),
      destination: unwrap(realDestinations[index] ?? { breach: "outside" }, entry.destination),
    }));
    return storeCopyFiles(context.db, resolved, options, context.now);
  });
  return { copied, remaining: entries.slice(copied) };
}

export function touchFilesOf(
  context: ViewContext,
  paths: readonly string[],
  options: TouchOptions,
): void {
  if (paths.length > TOUCH_PATH_LIMIT) {
    throw filesystemError("E2BIG", `touch accepts at most ${TOUCH_PATH_LIMIT} paths`);
  }
  const create = options.create !== false;
  const targets = paths.map((path) => writable(context, path, create ? "parent" : "exists"));
  if (targets.length === 0) return;
  context.translating(mountsOf(targets), () => {
    const resolved = resolveTargets(context, targets, true).map((real, index) =>
      unwrap(real, paths[index] ?? ""),
    );
    storeTouchFiles(context.db, resolved, options.mtime ?? context.now(), options.create);
  });
}

export function writeFileStreamOf(
  context: ViewContext,
  path: string,
  chunks: Iterable<Uint8Array>,
  options: StreamWriteOptions,
): void {
  const { mount, real } = writable(context, path, "parent");
  context.translating([mount], () => {
    const target = unwrap(resolveWithin(context.db, mount.source, real, true, mount.top), path);
    storeWriteStream(context.db, target, chunks, options.append === true, context.now());
  });
}

export function removeFilesOf(
  context: ViewContext,
  paths: readonly string[],
  options: RemoveOptions | undefined,
): void {
  const force = options?.force === true;
  const targets: Target[] = [];
  const named: string[] = [];
  for (const path of paths) {
    if (normalize(path) === "/") throw busy(path);
    const location = context.locate(path);
    if (location.kind === "absent" && force) continue;
    const target = writable(context, path, "exists", location);
    if (isMountRoot(target)) throw busy(path);
    targets.push(target);
    named.push(path);
  }
  context.translating(mountsOf(targets), () => {
    const resolved: RealPath[] = [];
    const found = resolveTargets(context, targets, false);
    for (let index = 0; index < found.length; index++) {
      const real = found[index];
      if (typeof real === "string") resolved.push(real);
      else if (!force) throw missing(named[index] ?? "");
    }
    storeRemoveFiles(context.db, resolved, options);
  });
}
