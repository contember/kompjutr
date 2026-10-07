// Single-path filesystem operations. Bulk storage stays in `store/`; these
// functions add POSIX path resolution, error mapping, and metadata semantics.

import type { SqlDatabase } from "../db/db.js";
import { filesystemError as fsError, hasErrorCode } from "./errors.js";
import { basename, dirname, join, normalize } from "./path.js";
import {
  chmodRaw,
  linkRaw,
  readdirRaw,
  renameRaw,
  statRaw,
  truncateRaw,
  writeRangeRaw,
} from "./store/ops.js";
import { readFile as readStoredFile, readRange as readStoredRange } from "./store/read.js";
import { removeFiles } from "./store/remove.js";
import { type PathResolver, storeResolver } from "./store/resolve.js";
import { writeFiles } from "./store/write.js";
import type { Dirent, FilesystemOptions, RemoveOptions, Stat } from "./types.js";

/** What a single-path operation needs: the store, its resolver, and a clock. */
interface OpsContext {
  readonly db: SqlDatabase;
  readonly resolver: PathResolver;
  readonly now: () => number;
}

function asMissing<T>(work: () => T): T | null {
  try {
    return work();
  } catch (error) {
    if (hasErrorCode(error, "ENOTDIR")) return null;
    throw error;
  }
}

function enotdirAsEnoent<T>(path: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (hasErrorCode(error, "ENOTDIR")) {
      throw fsError("ENOENT", "no such file or directory", path);
    }
    throw error;
  }
}

/** lstat semantics: resolve ancestors, but not a trailing symlink. */
function stat(context: OpsContext, path: string): Stat | null {
  return asMissing(() => statRaw(context.db, context.resolver.realpathNoFollow(path)));
}

/** stat semantics: follow every symlink, including the trailing one. */
function statTarget(context: OpsContext, path: string): Stat | null {
  return asMissing(() => statRaw(context.db, context.resolver.realpath(path)));
}

function exists(context: OpsContext, path: string): boolean {
  return statTarget(context, path) !== null;
}

function readFile(context: OpsContext, path: string): Uint8Array {
  return enotdirAsEnoent(path, () =>
    readStoredFile(context.db, path, context.resolver.realpath(path)),
  );
}

function readRange(context: OpsContext, path: string, offset: number, length: number): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw fsError("EINVAL", `invalid read offset: ${offset}`, path);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw fsError("EINVAL", `invalid read length: ${length}`, path);
  }
  return enotdirAsEnoent(path, () =>
    readStoredRange(context.db, path, offset, length, context.resolver.realpath(path)),
  );
}

function readlink(context: OpsContext, path: string): string {
  const found = stat(context, path);
  if (found === null) throw fsError("ENOENT", "no such file or directory", path);
  if (found.type !== "symlink" || found.target === null) {
    throw fsError("EINVAL", "not a symbolic link", path);
  }
  return found.target;
}

function readdir(context: OpsContext, path: string): Dirent[] {
  const real = context.resolver.realpath(path);
  const found = statRaw(context.db, real);
  if (found === null) throw fsError("ENOENT", "no such file or directory", path);
  if (found.type !== "dir") throw fsError("ENOTDIR", "not a directory", path);
  return readdirRaw(context.db, real);
}

/** writeFile follows a final symlink and never creates missing parents. */
function writeFile(
  context: OpsContext,
  path: string,
  bytes: Uint8Array,
  options: { mode?: number; contentId?: Uint8Array } = {},
): void {
  const target = context.resolver.realpath(path);
  writeFiles(
    context.db,
    [
      {
        path: target,
        bytes,
        mode: options.mode,
        contentId: options.contentId,
      },
    ],
    { parents: false },
    context.now,
    context.resolver,
  );
}

function createFile(context: OpsContext, path: string, mode: number): void {
  const target = context.resolver.realpath(path);
  writeFiles(
    context.db,
    [{ path: target, bytes: new Uint8Array(0), mode }],
    { parents: true },
    context.now,
    context.resolver,
  );
}

function writeRange(context: OpsContext, path: string, bytes: Uint8Array, offset: number): void {
  const target = context.resolver.realpath(path);
  writeRangeRaw(context.db, target, bytes, offset, context.now());
}

function truncate(context: OpsContext, path: string, length: number): void {
  const target = context.resolver.realpath(path);
  truncateRaw(context.db, target, length, context.now());
}

function mkdir(
  context: OpsContext,
  path: string,
  options: { recursive?: boolean; mode?: number } = {},
): void {
  const canonical = normalize(path);
  if (canonical === "/") throw fsError("EEXIST", "path exists", path);

  const existing = stat(context, canonical);
  if (existing !== null) {
    if (options.recursive === true && existing.type === "dir") return;
    throw fsError("EEXIST", "path exists", path);
  }

  writeFiles(
    context.db,
    [{ path: canonical, mode: options.mode }],
    { parents: options.recursive === true },
    context.now,
    context.resolver,
  );
}

function symlink(context: OpsContext, target: string, path: string): void {
  const canonical = normalize(path);
  if (canonical === "/" || stat(context, canonical) !== null) {
    throw fsError("EEXIST", "path exists", path);
  }
  writeFiles(
    context.db,
    [{ path: canonical, target }],
    { parents: false },
    context.now,
    context.resolver,
  );
}

function link(context: OpsContext, existingPath: string, newPath: string): void {
  const sourcePath = context.resolver.realpath(existingPath);
  const source = statRaw(context.db, sourcePath);
  if (source === null) throw fsError("ENOENT", "no such file or directory", existingPath);
  if (source.type !== "file") throw fsError("EPERM", "cannot hardlink a non-file", existingPath);

  const canonicalNew = normalize(newPath);
  if (canonicalNew === "/") throw fsError("EEXIST", "path exists", newPath);
  const parent = context.resolver.realpath(dirname(canonicalNew));
  const parentStat = statRaw(context.db, parent);
  if (parentStat === null) throw fsError("ENOENT", "parent directory missing", newPath);
  if (parentStat.type !== "dir") throw fsError("ENOTDIR", "parent is not a directory", newPath);
  const target = context.resolver.realpathNoFollow(join(parent, basename(canonicalNew)));
  if (statRaw(context.db, target) !== null) throw fsError("EEXIST", "path exists", newPath);
  linkRaw(context.db, sourcePath, target);
}

function unlink(context: OpsContext, path: string): void {
  const target = context.resolver.realpathNoFollow(path);
  const found = statRaw(context.db, target);
  if (found === null) throw fsError("ENOENT", "no such file or directory", path);
  if (found.type === "dir") throw fsError("EISDIR", "illegal operation on a directory", path);
  removeFiles(context.db, [target], { force: false });
}

function rmdir(context: OpsContext, path: string): void {
  const target = context.resolver.realpathNoFollow(path);
  const found = statRaw(context.db, target);
  if (found === null) throw fsError("ENOENT", "no such file or directory", path);
  if (found.type !== "dir") throw fsError("ENOTDIR", "not a directory", path);
  removeFiles(context.db, [target], { force: false });
}

function rm(context: OpsContext, path: string, options: RemoveOptions = {}): void {
  const target = context.resolver.realpathNoFollow(path);
  if (target === "/") throw fsError("EPERM", "cannot remove the root directory", path);
  removeFiles(context.db, [target], options);
}

function rename(context: OpsContext, oldPath: string, newPath: string): void {
  const sourcePath = context.resolver.realpathNoFollow(oldPath);
  const source = statRaw(context.db, sourcePath);
  if (source === null) throw fsError("ENOENT", "no such file or directory", oldPath);
  if (sourcePath === "/") throw fsError("EINVAL", "cannot rename root", oldPath);

  const canonicalNew = normalize(newPath);
  if (canonicalNew === "/") throw fsError("EINVAL", "cannot rename onto root", newPath);
  const targetParent = context.resolver.realpath(dirname(canonicalNew));
  const parentStat = statRaw(context.db, targetParent);
  if (parentStat === null) throw fsError("ENOENT", "parent directory missing", newPath);
  if (parentStat.type !== "dir") throw fsError("ENOTDIR", "parent is not a directory", newPath);
  const targetPath = context.resolver.realpathNoFollow(join(targetParent, basename(canonicalNew)));
  if (sourcePath === targetPath) return;
  if (source.type === "dir" && targetPath.startsWith(`${sourcePath}/`)) {
    throw fsError("EINVAL", "cannot rename a directory into itself", newPath);
  }

  const target = statRaw(context.db, targetPath);
  if (target !== null) {
    if (source.type === "dir" && target.type !== "dir") {
      throw fsError("ENOTDIR", "cannot overwrite a non-directory", newPath);
    }
    if (source.type !== "dir" && target.type === "dir") {
      throw fsError("EISDIR", "cannot overwrite a directory", newPath);
    }
  }

  renameRaw(context.db, sourcePath, targetPath);
}

function chmod(context: OpsContext, path: string, mode: number): void {
  const target = context.resolver.realpath(path);
  const found = statRaw(context.db, target);
  if (found === null) throw fsError("ENOENT", "no such file or directory", path);
  chmodRaw(context.db, target, mode, context.now());
}

/** The surface Wave INT delegates into the complete `Filesystem`. */
export interface FilesystemOps {
  readonly db: SqlDatabase;
  stat(path: string): Stat | null;
  statTarget(path: string): Stat | null;
  exists(path: string): boolean;
  readFile(path: string): Uint8Array;
  readRange(path: string, offset: number, length: number): Uint8Array;
  readlink(path: string): string;
  readdir(path: string): Dirent[];
  writeFile(
    path: string,
    bytes: Uint8Array,
    options?: { mode?: number; contentId?: Uint8Array },
  ): void;
  createFile(path: string, mode: number): void;
  writeRange(path: string, bytes: Uint8Array, offset: number): void;
  truncate(path: string, length: number): void;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  symlink(target: string, path: string): void;
  link(existingPath: string, newPath: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  rm(path: string, options?: RemoveOptions): void;
  rename(oldPath: string, newPath: string): void;
  chmod(path: string, mode: number): void;
}

export interface FilesystemOpsOptions extends FilesystemOptions {
  /** Defaults to the store's own resolver. A mounted view confines it. */
  resolver?: PathResolver;
}

export function createFilesystemOps(
  db: SqlDatabase,
  options: FilesystemOpsOptions = {},
): FilesystemOps {
  const context: OpsContext = {
    db,
    resolver: options.resolver ?? storeResolver(db),
    now: options.now ?? Date.now,
  };
  return {
    db,
    stat: (path) => stat(context, path),
    statTarget: (path) => statTarget(context, path),
    exists: (path) => exists(context, path),
    readFile: (path) => readFile(context, path),
    readRange: (path, offset, length) => readRange(context, path, offset, length),
    readlink: (path) => readlink(context, path),
    readdir: (path) => readdir(context, path),
    writeFile: (path, bytes, writeOptions) => writeFile(context, path, bytes, writeOptions),
    createFile: (path, mode) => createFile(context, path, mode),
    writeRange: (path, bytes, offset) => writeRange(context, path, bytes, offset),
    truncate: (path, length) => truncate(context, path, length),
    mkdir: (path, mkdirOptions) => mkdir(context, path, mkdirOptions),
    symlink: (target, path) => symlink(context, target, path),
    link: (existingPath, newPath) => link(context, existingPath, newPath),
    unlink: (path) => unlink(context, path),
    rmdir: (path) => rmdir(context, path),
    rm: (path, removeOptions) => rm(context, path, removeOptions),
    rename: (oldPath, newPath) => rename(context, oldPath, newPath),
    chmod: (path, mode) => chmod(context, path, mode),
  };
}
