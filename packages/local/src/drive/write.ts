import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import type { WriteEntry, WriteOptions } from "@kompjutr/drive";
import { localError, normalizeHostError } from "../errors.js";
import { comparePaths, type PathMapper, virtualParent } from "../paths.js";
import type { RecoveryCoordinator } from "../recovery/coordinator.js";
import { pathExists, syncDirectory } from "../recovery/fs.js";

function validateMode(mode: number | undefined): number {
  const value = mode ?? 0o644;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o7777) {
    throw localError("EINVAL", "file mode is invalid");
  }
  return value;
}

function writeAll(fd: number, bytes: Uint8Array, position?: number): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(
      fd,
      bytes,
      offset,
      bytes.length - offset,
      position === undefined ? null : position + offset,
    );
    if (written === 0) throw localError("EIO", "file write made no progress");
    offset += written;
  }
}

function requireMutationTarget(path: string): void {
  if (path === "/") throw localError("EPERM", "cannot replace the workspace root", path);
}

function ensureDirectories(mapper: PathMapper, recovery: RecoveryCoordinator, path: string): void {
  if (path === "/") return;
  let virtual = "";
  let parentHost = mapper.root;
  for (const part of path.slice(1).split("/")) {
    virtual += `/${part}`;
    const host = mapper.lexicalHost(virtual);
    if (!pathExists(host)) {
      mkdirSync(host, 0o755);
      syncDirectory(parentHost);
      syncDirectory(host);
      recovery.parentCreated();
    } else if (!lstatSync(host).isDirectory()) {
      throw localError("ENOTDIR", "parent path is not a directory", virtual);
    }
    parentHost = host;
  }
}

function requireParent(
  mapper: PathMapper,
  recovery: RecoveryCoordinator,
  path: string,
  parents: boolean,
): void {
  const parent = virtualParent(path);
  if (parents) {
    ensureDirectories(mapper, recovery, parent);
    return;
  }
  const host = mapper.lexicalHost(parent);
  if (!pathExists(host)) throw localError("ENOENT", "parent directory does not exist", path);
  if (!lstatSync(host).isDirectory())
    throw localError("ENOTDIR", "parent path is not a directory", path);
}

function replaceFile(
  mapper: PathMapper,
  recovery: RecoveryCoordinator,
  path: string,
  bytes: Uint8Array,
  mode: number,
  parents: boolean,
): void {
  requireParent(mapper, recovery, path, parents);
  const parent = virtualParent(path);
  const temporary = recovery.temporary(parent);
  const fd = openSync(temporary, "wx", mode);
  try {
    writeAll(fd, bytes);
    chmodSync(temporary, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  recovery.checkpoint("replacement-synced");
  renameSync(temporary, mapper.lexicalHost(path));
  syncDirectory(mapper.lexicalHost(parent));
  recovery.markChanged();
  recovery.checkpoint("replacement-renamed");
}

function replaceFromSource(
  mapper: PathMapper,
  recovery: RecoveryCoordinator,
  path: string,
  source: string,
  mode: number,
  patch?: { readonly bytes: Uint8Array; readonly offset: number },
): void {
  const parent = virtualParent(path);
  const temporary = recovery.temporary(parent);
  copyFileSync(source, temporary, constants.COPYFILE_EXCL);
  chmodSync(temporary, mode);
  const fd = openSync(temporary, patch === undefined ? "r" : "r+");
  try {
    if (patch !== undefined) writeAll(fd, patch.bytes, patch.offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  recovery.checkpoint("replacement-synced");
  renameSync(temporary, mapper.lexicalHost(path));
  syncDirectory(mapper.lexicalHost(parent));
  recovery.markChanged();
  recovery.checkpoint("replacement-renamed");
}

export class DiskWriter {
  readonly #mapper: PathMapper;
  readonly #recovery: RecoveryCoordinator;

  constructor(mapper: PathMapper, recovery: RecoveryCoordinator) {
    this.#mapper = mapper;
    this.#recovery = recovery;
  }

  writeFile(path: string, bytes: Uint8Array, mode?: number, parents = false): void {
    const canonical = this.#mapper.resolve(path, true);
    requireMutationTarget(canonical);
    const host = this.#mapper.lexicalHost(canonical);
    if (pathExists(host) && lstatSync(host).isDirectory()) {
      throw localError("EISDIR", "cannot replace a directory", canonical);
    }
    this.#recovery.prepare([canonical]);
    replaceFile(this.#mapper, this.#recovery, canonical, bytes, validateMode(mode), parents);
  }

  writeFiles(entries: readonly WriteEntry[], options: WriteOptions = {}): void {
    const byPath = new Map<string, WriteEntry>();
    for (const entry of entries) {
      const variants = Number(entry.bytes !== undefined) + Number(entry.target !== undefined);
      if (variants > 1)
        throw localError("EINVAL", "write entry has conflicting payloads", entry.path);
      if (
        entry.target !== undefined &&
        (!entry.target.isWellFormed() || entry.target.includes("\0"))
      ) {
        throw localError("EINVAL", "symbolic link target is not valid UTF-8", entry.path);
      }
      const path = this.#mapper.resolve(entry.path, false);
      requireMutationTarget(path);
      byPath.set(path, entry);
    }
    const planned = [...byPath].map(([path, entry]) => ({ entry, path }));
    planned.sort((left, right) => comparePaths(left.path, right.path));
    const actionable = planned.filter((item) => {
      const host = this.#mapper.lexicalHost(item.path);
      if (!pathExists(host)) return true;
      const existingDirectory = lstatSync(host).isDirectory();
      const targetDirectory = item.entry.bytes === undefined && item.entry.target === undefined;
      if (existingDirectory && targetDirectory) return false;
      if (existingDirectory) throw localError("EISDIR", "cannot replace a directory", item.path);
      if (targetDirectory) {
        throw localError("EEXIST", "cannot replace a non-directory with a directory", item.path);
      }
      return true;
    });
    this.#recovery.prepare(actionable.map((item) => item.path));
    for (const item of actionable) {
      const { entry, path } = item;
      if (entry.bytes !== undefined) {
        replaceFile(
          this.#mapper,
          this.#recovery,
          path,
          entry.bytes,
          validateMode(entry.mode),
          options.parents !== false,
        );
      } else if (entry.target !== undefined) {
        requireParent(this.#mapper, this.#recovery, path, options.parents !== false);
        symlinkSync(entry.target, this.#mapper.lexicalHost(path));
        syncDirectory(this.#mapper.lexicalHost(virtualParent(path)));
        this.#recovery.markChanged();
      } else {
        requireParent(this.#mapper, this.#recovery, path, options.parents !== false);
        mkdirSync(this.#mapper.lexicalHost(path), validateMode(entry.mode ?? 0o755));
        syncDirectory(this.#mapper.lexicalHost(virtualParent(path)));
        syncDirectory(this.#mapper.lexicalHost(path));
        this.#recovery.markChanged();
      }
    }
  }

  makeDirectories(paths: readonly string[]): void {
    const canonical = paths.map((path) => this.#mapper.resolve(path, false));
    const missing = canonical.filter((path) => !pathExists(this.#mapper.lexicalHost(path)));
    this.#recovery.prepare(missing);
    for (const path of canonical) {
      const host = this.#mapper.lexicalHost(path);
      if (pathExists(host)) {
        if (!lstatSync(host).isDirectory())
          throw localError("ENOTDIR", "path is not a directory", path);
        continue;
      }
      ensureDirectories(this.#mapper, this.#recovery, path);
    }
  }

  symlink(target: string, path: string): void {
    if (!target.isWellFormed() || target.includes("\0"))
      throw localError("EINVAL", "symbolic link target is not valid UTF-8", path);
    const canonical = this.#mapper.resolve(path, false);
    requireMutationTarget(canonical);
    if (pathExists(this.#mapper.lexicalHost(canonical)))
      throw localError("EEXIST", "path exists", path);
    this.#recovery.prepare([canonical]);
    requireParent(this.#mapper, this.#recovery, canonical, false);
    symlinkSync(target, this.#mapper.lexicalHost(canonical));
    syncDirectory(this.#mapper.lexicalHost(virtualParent(canonical)));
    this.#recovery.markChanged();
  }

  remove(paths: readonly string[], recursive: boolean, force: boolean): void {
    const canonical = paths.map((path) => this.#mapper.resolve(path, false));
    const existing: string[] = [];
    for (const path of canonical) {
      if (path === "/") throw localError("EPERM", "cannot remove the workspace root", path);
      const host = this.#mapper.lexicalHost(path);
      if (!pathExists(host)) {
        if (!force) throw localError("ENOENT", "path does not exist", path);
        continue;
      }
      const stat = lstatSync(host);
      if (stat.isDirectory() && !recursive && readdirHasEntry(host)) {
        throw localError("ENOTEMPTY", "directory is not empty", path);
      }
      existing.push(path);
    }
    const prepared = this.#recovery.prepare(existing);
    for (const item of prepared) {
      if (item.moved || !pathExists(item.host)) continue;
      rmSync(item.host, { force, recursive });
      syncDirectory(dirname(item.host));
      this.#recovery.markChanged();
    }
  }

  writeRange(path: string, bytes: Uint8Array, offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw localError("EINVAL", "write offset must be a safe nonnegative integer", path);
    }
    const canonical = this.#mapper.resolve(path, true);
    requireMutationTarget(canonical);
    const host = this.#mapper.lexicalHost(canonical);
    if (!pathExists(host)) throw localError("ENOENT", "path does not exist", path);
    const stat = lstatSync(host);
    if (!stat.isFile())
      throw localError("EINVAL", "write range target is not a regular file", path);
    const prepared = this.#recovery.prepare([canonical])[0];
    if (prepared?.source === null || prepared === undefined)
      throw localError("EIO", "write source disappeared", path);
    replaceFromSource(this.#mapper, this.#recovery, canonical, prepared.source, stat.mode, {
      bytes,
      offset,
    });
  }

  chmod(path: string, mode: number): void {
    const canonical = this.#mapper.resolve(path, true);
    requireMutationTarget(canonical);
    const host = this.#mapper.lexicalHost(canonical);
    if (!pathExists(host)) throw localError("ENOENT", "path does not exist", path);
    const stat = lstatSync(host);
    if (!stat.isFile())
      throw localError("EUNSUPPORTED", "local chmod currently requires a regular file", path);
    const prepared = this.#recovery.prepare([canonical])[0];
    if (prepared?.source === null || prepared === undefined)
      throw localError("EIO", "chmod source disappeared", path);
    replaceFromSource(this.#mapper, this.#recovery, canonical, prepared.source, validateMode(mode));
  }
}

function readdirHasEntry(path: string): boolean {
  const directory = opendirSync(path);
  try {
    return directory.readSync() !== null;
  } catch (error) {
    normalizeHostError(error, "read directory", path);
  } finally {
    directory.closeSync();
  }
}
