// Single-path filesystem operations. Bulk storage stays in `store/`; these
// functions add POSIX path resolution, error mapping, and metadata semantics.

import type { SqlDatabase } from "../sqlite/db.js";
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
import { realpath, realpathNoFollow } from "./store/resolve.js";
import { writeFiles } from "./store/write.js";
import type { Dirent, FilesystemOptions, RemoveOptions, Stat } from "./types.js";

function fsError(code: string, message: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${message}, '${path}'`), { code, path });
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function asMissing<T>(work: () => T): T | null {
  try {
    return work();
  } catch (error) {
    if (hasCode(error, "ENOTDIR")) return null;
    throw error;
  }
}

function enotdirAsEnoent<T>(path: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (hasCode(error, "ENOTDIR")) {
      throw fsError("ENOENT", "no such file or directory", path);
    }
    throw error;
  }
}

/** lstat semantics: resolve ancestors, but not a trailing symlink. */
export function stat(db: SqlDatabase, path: string): Stat | null {
  return asMissing(() => statRaw(db, realpathNoFollow(db, path)));
}

/** stat semantics: follow every symlink, including the trailing one. */
export function statTarget(db: SqlDatabase, path: string): Stat | null {
  return asMissing(() => statRaw(db, realpath(db, path)));
}

export function exists(db: SqlDatabase, path: string): boolean {
  return statTarget(db, path) !== null;
}

export function readFile(db: SqlDatabase, path: string): Uint8Array {
  return enotdirAsEnoent(path, () => readStoredFile(db, path));
}

export function readRange(
  db: SqlDatabase,
  path: string,
  offset: number,
  length: number,
): Uint8Array {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw fsError("EINVAL", `invalid read offset: ${offset}`, path);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw fsError("EINVAL", `invalid read length: ${length}`, path);
  }
  return enotdirAsEnoent(path, () => readStoredRange(db, path, offset, length));
}

export function readlink(db: SqlDatabase, path: string): string {
  const found = stat(db, path);
  if (found === null) throw fsError("ENOENT", "no such file or directory", path);
  if (found.type !== "symlink" || found.target === null) {
    throw fsError("EINVAL", "not a symbolic link", path);
  }
  return found.target;
}

export function readdir(db: SqlDatabase, path: string): Dirent[] {
  const real = realpath(db, path);
  const found = statRaw(db, real);
  if (found === null) throw fsError("ENOENT", "no such file or directory", path);
  if (found.type !== "dir") throw fsError("ENOTDIR", "not a directory", path);
  return readdirRaw(db, real);
}

/** writeFile follows a final symlink and never creates missing parents. */
export function writeFile(
  db: SqlDatabase,
  path: string,
  bytes: Uint8Array,
  options: { mode?: number; contentId?: Uint8Array } = {},
  now: () => number = Date.now,
): void {
  const target = realpath(db, path);
  writeFiles(
    db,
    [
      {
        path: target,
        bytes,
        mode: options.mode,
        contentId: options.contentId,
        mtime: now(),
      },
    ],
    { parents: false },
  );
}

export function createFile(
  db: SqlDatabase,
  path: string,
  mode: number,
  now: () => number = Date.now,
): void {
  const target = realpath(db, path);
  writeFiles(db, [{ path: target, bytes: new Uint8Array(0), mode, mtime: now() }], {
    parents: true,
  });
}

export function writeRange(
  db: SqlDatabase,
  path: string,
  bytes: Uint8Array,
  offset: number,
  now: () => number = Date.now,
): void {
  const target = realpath(db, path);
  writeRangeRaw(db, target, bytes, offset, now());
}

export function truncate(
  db: SqlDatabase,
  path: string,
  length: number,
  now: () => number = Date.now,
): void {
  const target = realpath(db, path);
  truncateRaw(db, target, length, now());
}

export function mkdir(
  db: SqlDatabase,
  path: string,
  options: { recursive?: boolean; mode?: number } = {},
  now: () => number = Date.now,
): void {
  const canonical = normalize(path);
  if (canonical === "/") throw fsError("EEXIST", "path exists", path);

  const existing = stat(db, canonical);
  if (existing !== null) {
    if (options.recursive === true && existing.type === "dir") return;
    throw fsError("EEXIST", "path exists", path);
  }

  writeFiles(db, [{ path: canonical, mode: options.mode, mtime: now() }], {
    parents: options.recursive === true,
  });
}

export function symlink(
  db: SqlDatabase,
  target: string,
  path: string,
  now: () => number = Date.now,
): void {
  const canonical = normalize(path);
  if (canonical === "/" || stat(db, canonical) !== null) {
    throw fsError("EEXIST", "path exists", path);
  }
  writeFiles(db, [{ path: canonical, target, mtime: now() }], { parents: false });
}

export function link(db: SqlDatabase, existingPath: string, newPath: string): void {
  const sourcePath = realpath(db, existingPath);
  const source = statRaw(db, sourcePath);
  if (source === null) throw fsError("ENOENT", "no such file or directory", existingPath);
  if (source.type !== "file") throw fsError("EPERM", "cannot hardlink a non-file", existingPath);

  const canonicalNew = normalize(newPath);
  if (canonicalNew === "/") throw fsError("EEXIST", "path exists", newPath);
  const parent = realpath(db, dirname(canonicalNew));
  const parentStat = statRaw(db, parent);
  if (parentStat === null) throw fsError("ENOENT", "parent directory missing", newPath);
  if (parentStat.type !== "dir") throw fsError("ENOTDIR", "parent is not a directory", newPath);
  const target = realpathNoFollow(db, join(parent, basename(canonicalNew)));
  if (statRaw(db, target) !== null) throw fsError("EEXIST", "path exists", newPath);
  linkRaw(db, sourcePath, target);
}

export function unlink(db: SqlDatabase, path: string): void {
  const target = realpathNoFollow(db, path);
  const found = statRaw(db, target);
  if (found === null) throw fsError("ENOENT", "no such file or directory", path);
  if (found.type === "dir") throw fsError("EISDIR", "illegal operation on a directory", path);
  removeFiles(db, [target], { force: false });
}

export function rmdir(db: SqlDatabase, path: string): void {
  const target = realpathNoFollow(db, path);
  const found = statRaw(db, target);
  if (found === null) throw fsError("ENOENT", "no such file or directory", path);
  if (found.type !== "dir") throw fsError("ENOTDIR", "not a directory", path);
  removeFiles(db, [target], { force: false });
}

export function rm(db: SqlDatabase, path: string, options: RemoveOptions = {}): void {
  const target = realpathNoFollow(db, path);
  if (target === "/") throw fsError("EPERM", "cannot remove the root directory", path);
  removeFiles(db, [target], options);
}

export function rename(db: SqlDatabase, oldPath: string, newPath: string): void {
  const sourcePath = realpathNoFollow(db, oldPath);
  const source = statRaw(db, sourcePath);
  if (source === null) throw fsError("ENOENT", "no such file or directory", oldPath);
  if (sourcePath === "/") throw fsError("EINVAL", "cannot rename root", oldPath);

  const canonicalNew = normalize(newPath);
  if (canonicalNew === "/") throw fsError("EINVAL", "cannot rename onto root", newPath);
  const targetParent = realpath(db, dirname(canonicalNew));
  const parentStat = statRaw(db, targetParent);
  if (parentStat === null) throw fsError("ENOENT", "parent directory missing", newPath);
  if (parentStat.type !== "dir") throw fsError("ENOTDIR", "parent is not a directory", newPath);
  const targetPath = realpathNoFollow(db, join(targetParent, basename(canonicalNew)));
  if (sourcePath === targetPath) return;
  if (source.type === "dir" && targetPath.startsWith(`${sourcePath}/`)) {
    throw fsError("EINVAL", "cannot rename a directory into itself", newPath);
  }

  const target = statRaw(db, targetPath);
  if (target !== null) {
    if (source.type === "dir" && target.type !== "dir") {
      throw fsError("ENOTDIR", "cannot overwrite a non-directory", newPath);
    }
    if (source.type !== "dir" && target.type === "dir") {
      throw fsError("EISDIR", "cannot overwrite a directory", newPath);
    }
  }

  renameRaw(db, sourcePath, targetPath);
}

export function chmod(
  db: SqlDatabase,
  path: string,
  mode: number,
  now: () => number = Date.now,
): void {
  const target = realpath(db, path);
  const found = statRaw(db, target);
  if (found === null) throw fsError("ENOENT", "no such file or directory", path);
  chmodRaw(db, target, mode, now());
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

export function createFilesystemOps(
  db: SqlDatabase,
  options: FilesystemOptions = {},
): FilesystemOps {
  const now = options.now ?? Date.now;
  return {
    db,
    stat: (path) => stat(db, path),
    statTarget: (path) => statTarget(db, path),
    exists: (path) => exists(db, path),
    readFile: (path) => readFile(db, path),
    readRange: (path, offset, length) => readRange(db, path, offset, length),
    readlink: (path) => readlink(db, path),
    readdir: (path) => readdir(db, path),
    writeFile: (path, bytes, writeOptions) => writeFile(db, path, bytes, writeOptions, now),
    createFile: (path, mode) => createFile(db, path, mode, now),
    writeRange: (path, bytes, offset) => writeRange(db, path, bytes, offset, now),
    truncate: (path, length) => truncate(db, path, length, now),
    mkdir: (path, mkdirOptions) => mkdir(db, path, mkdirOptions, now),
    symlink: (target, path) => symlink(db, target, path, now),
    link: (existingPath, newPath) => link(db, existingPath, newPath),
    unlink: (path) => unlink(db, path),
    rmdir: (path) => rmdir(db, path),
    rm: (path, removeOptions) => rm(db, path, removeOptions),
    rename: (oldPath, newPath) => rename(db, oldPath, newPath),
    chmod: (path, mode) => chmod(db, path, mode, now),
  };
}
