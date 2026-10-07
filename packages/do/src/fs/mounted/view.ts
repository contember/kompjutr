// `createMountedFilesystem`: one workspace database, several virtual
// namespaces over it.
//
// Hosts that run several agent sessions over one workspace give each session
// a view: its own directories mounted at fixed virtual paths, everything else
// invisible. The view is a `Filesystem`, so the shell runs over it unchanged.
//
// It fails closed. Resolution is confined to the mount it starts in, so a
// symlink that climbs out of its source, names an absolute target, or points
// at another mount resolves as absent — unlike a kernel bind mount, which
// would follow it. Paths outside every mount are absent without a statement,
// and errors quote virtual paths only.

import { filesystemError } from "../errors.js";
import { type FilesystemInternals, filesystemInternals, ResolvedRoots } from "../internals.js";
import { normalize } from "../path.js";
import type { Filesystem } from "../types.js";
import {
  missing,
  readOnly,
  resolvedRoot,
  resolveRoot,
  ViewContext,
  type ViewRoot,
} from "./context.js";
import { type Mount, type MountSpec, MountTable } from "./mounts.js";
import {
  readdirOf,
  readFileHandlesOf,
  readFileOf,
  readFilesOf,
  readlinkOf,
  readRangeOf,
  realpathOf,
  statOf,
} from "./reads.js";
import { listPage, scanPage, scanStreamFrom } from "./scan.js";
import { discoverFrom, globFrom, globPageFrom, searchFrom } from "./search.js";
import {
  busy,
  copyFilesOf,
  crossDevice,
  isMountRoot,
  notMountRoot,
  removeFilesOf,
  type Target,
  touchFilesOf,
  writable,
  writeFileStreamOf,
  writeFilesOf,
} from "./writes.js";

export type { MountMode, MountSpec } from "./mounts.js";

function openMounts(base: Filesystem, specs: readonly MountSpec[]): ViewContext {
  const internals: FilesystemInternals | undefined = filesystemInternals(base);
  if (internals === undefined) {
    throw filesystemError("EINVAL", "a mounted view needs a filesystem from createFilesystem");
  }
  const table = new MountTable(specs);
  const sources = new Map<Mount, ReturnType<Filesystem["realpath"]>>();
  for (const mount of table.mounts) {
    const real = base.realpath(mount.source);
    if (real !== mount.source) {
      throw filesystemError("EINVAL", "mount source must be a real path", mount.source);
    }
    const stat = base.stat(real);
    if (stat === null) throw filesystemError("ENOENT", "mount source missing", mount.source);
    if (stat.type !== "dir") {
      throw filesystemError("ENOTDIR", "mount source is not a directory", mount.source);
    }
    sources.set(mount, real);
  }
  return new ViewContext(internals.db, table, internals.now, sources);
}

/**
 * A `Filesystem` that shows `mounts` and nothing else. `base` must come from
 * `createFilesystem`; the view shares its database, clock, and revision.
 */
export function createMountedFilesystem(
  base: Filesystem,
  mounts: readonly MountSpec[],
): Filesystem {
  const context = openMounts(base, mounts);
  const internals = filesystemInternals(base);
  if (internals === undefined) throw new Error("mounted view: base internals disappeared");
  const mutated = internals.mutated;
  const scanRoots = new ResolvedRoots<ViewRoot>(internals.epoch);
  const globRoots = new ResolvedRoots<ViewRoot>(internals.epoch);
  const listRoots = new ResolvedRoots<ViewRoot>(internals.epoch);
  const single = <T>(target: Target, work: () => T): T => {
    const result = context.translating([target.mount], work);
    mutated();
    return result;
  };
  const ops = (target: Target) => context.ops(target.mount);

  const view: Filesystem = {
    db: base.db,
    mutationScope: base.mutationScope,
    rev: () => base.rev(),
    realpath: (path) => realpathOf(context, path),
    stat: (path) => statOf(context, path, false),
    statTarget: (path) => statOf(context, path, true),
    exists: (path) => statOf(context, path, true) !== null,
    readFile: (path) => readFileOf(context, path),
    readRange: (path, offset, length) => readRangeOf(context, path, offset, length),
    readlink: (path) => readlinkOf(context, path),
    readdir: (path) => readdirOf(context, path),
    scan(root, options) {
      const fresh = options.after === undefined && options.afterSubtree === undefined;
      const resolved = (fresh ? undefined : scanRoots.get(root)) ?? resolveRoot(context, root);
      const page = scanPage(context, resolved, options);
      scanRoots.keep(root, resolved, page.length >= options.limit);
      return page;
    },
    scanStream: (root, options = {}) =>
      scanStreamFrom(context, resolvedRoot(context, root), options),
    discoverFiles: (root, pattern, options = {}) =>
      discoverFrom(context, resolvedRoot(context, root), pattern, options),
    discoverFilesContaining: (root, pattern, needle, options = {}) =>
      searchFrom(context, resolvedRoot(context, root), pattern, needle, options),
    readFileHandles: (handles, options) => readFileHandlesOf(context, handles, options),
    readFiles: (paths, options) => readFilesOf(context, paths, options),
    glob: (root, pattern, options = {}) =>
      globFrom(context, resolveRoot(context, root), pattern, options),
    globPage(root, pattern, options = {}) {
      const cached = options.after === undefined ? undefined : globRoots.get(root);
      const resolved = cached ?? resolveRoot(context, root);
      const page = globPageFrom(context, resolved, pattern, options);
      globRoots.keep(root, resolved, page.next !== null);
      return page;
    },
    listEntries(root, options = {}) {
      const cached = options.after === undefined ? undefined : listRoots.get(root);
      const resolved = cached ?? resolveRoot(context, root);
      const page = listPage(context, resolved, options);
      listRoots.keep(root, resolved, page.next !== null);
      return page;
    },
    writeFiles(entries, options) {
      writeFilesOf(context, entries, options);
      mutated();
    },
    copyFiles(entries, options) {
      const batch = copyFilesOf(context, entries, options);
      if (batch.copied > 0) mutated();
      return batch;
    },
    touchFiles(paths, options = {}) {
      touchFilesOf(context, paths, options);
      if (paths.length > 0) mutated();
    },
    writeFileStream(path, chunks, options = {}) {
      writeFileStreamOf(context, path, chunks, options);
      mutated();
    },
    makeDirectories(paths) {
      writeFilesOf(
        context,
        paths.map((path) => ({ path })),
        { parents: true },
      );
      mutated();
    },
    removeFiles(paths, options) {
      removeFilesOf(context, paths, options);
      mutated();
    },
    writeFile(path, bytes, options) {
      const target = notMountRoot(context, path, writable(context, path, "parent"));
      single(target, () => ops(target).writeFile(target.real, bytes, options));
    },
    createFile(path, mode) {
      const target = notMountRoot(context, path, writable(context, path, "creates"));
      single(target, () => ops(target).createFile(target.real, mode));
    },
    writeRange(path, bytes, offset) {
      const target = writable(context, path, "exists");
      single(target, () => ops(target).writeRange(target.real, bytes, offset));
    },
    truncate(path, length) {
      const target = writable(context, path, "exists");
      single(target, () => ops(target).truncate(target.real, length));
    },
    mkdir: (path, options = {}) => mkdirOf(context, single, path, options),
    symlink(linkTarget, path) {
      const target = notMountRoot(context, path, writable(context, path, "parent"));
      single(target, () => ops(target).symlink(linkTarget, target.real));
    },
    link: (existingPath, newPath) => linkOf(context, single, existingPath, newPath),
    unlink(path) {
      const target = notMountRoot(context, path, writable(context, path, "exists"));
      single(target, () => ops(target).unlink(target.real));
    },
    rmdir(path) {
      if (normalize(path) === "/") throw busy(path);
      const target = notMountRoot(context, path, writable(context, path, "exists"));
      single(target, () => ops(target).rmdir(target.real));
    },
    rm(path, options = {}) {
      if (normalize(path) === "/") {
        throw filesystemError("EPERM", "cannot remove the root directory", path);
      }
      const location = context.locate(path);
      if (options.force === true && location.kind === "absent") return;
      const target = notMountRoot(context, path, writable(context, path, "exists", location));
      single(target, () => ops(target).rm(target.real, options));
    },
    rename: (oldPath, newPath) => renameOf(context, single, oldPath, newPath),
    chmod(path, mode) {
      const target = writable(context, path, "exists");
      single(target, () => ops(target).chmod(target.real, mode));
    },
    withReadScope: (work) => base.withReadScope(work),
  };
  return view;
}

type Single = <T>(target: Target, work: () => T) => T;

function mkdirOf(
  context: ViewContext,
  single: Single,
  path: string,
  options: Parameters<Filesystem["mkdir"]>[1] = {},
): void {
  const recursive = options.recursive === true;
  const location = context.locate(path);
  if (location.kind === "synthetic" || normalize(path) === "/") {
    if (recursive && location.kind === "synthetic") return;
    throw filesystemError("EEXIST", "path exists", path);
  }
  const target = writable(context, path, recursive ? "creates" : "parent", location);
  if (isMountRoot(context, target)) {
    // The mount point exists for as long as the view does.
    if (recursive) return;
    throw busy(path);
  }
  single(target, () => context.ops(target.mount).mkdir(target.real, options));
}

function linkOf(context: ViewContext, single: Single, existingPath: string, newPath: string): void {
  const source = context.locate(existingPath);
  if (source.kind === "absent") throw missing(existingPath);
  if (source.kind === "synthetic") {
    throw filesystemError("EPERM", "cannot hardlink a non-file", existingPath);
  }
  const target = notMountRoot(context, newPath, writable(context, newPath, "parent"));
  if (source.mount !== target.mount) throw crossDevice(newPath);
  single(target, () => context.ops(target.mount).link(source.real, target.real));
}

function renameOf(context: ViewContext, single: Single, oldPath: string, newPath: string): void {
  if (normalize(oldPath) === "/") throw filesystemError("EINVAL", "cannot rename root", oldPath);
  if (normalize(newPath) === "/") {
    throw filesystemError("EINVAL", "cannot rename onto root", newPath);
  }
  const source = context.locate(oldPath);
  if (source.kind === "absent") throw missing(oldPath);
  if (source.kind === "synthetic" || source.mount.mode === "ro") throw readOnly(oldPath);
  notMountRoot(context, oldPath, source);
  const target = notMountRoot(context, newPath, writable(context, newPath, "parent"));
  if (source.mount !== target.mount) throw crossDevice(newPath);
  single(target, () => context.ops(target.mount).rename(source.real, target.real));
}
