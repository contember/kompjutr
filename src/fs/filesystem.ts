import type { SqlDatabase } from "../sqlite/db.js";
import { assertComputerImportCurrent } from "./import.js";
import { createFilesystemOps } from "./ops.js";
import { initializeFsSchema } from "./schema.js";
import { currentRev } from "./store/meta.js";
import { readFileHandles, readFiles as readStoredFiles } from "./store/read.js";
import { removeFiles as removeStoredFiles } from "./store/remove.js";
import { realpath, realpaths, realpathsNoFollow } from "./store/resolve.js";
import { discoverFiles, glob as scanGlob, scan as scanPage } from "./store/scan.js";
import {
  makeDirectories as makeStoredDirectories,
  writeFiles as writeStoredFiles,
} from "./store/write.js";
import type {
  Filesystem,
  FilesystemOptions,
  ReadBatch,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  WriteEntry,
  WriteOptions,
} from "./types.js";

/** Open the standalone filesystem over one Durable Object SQLite database. */
export function createFilesystem(db: SqlDatabase, options: FilesystemOptions = {}): Filesystem {
  const now = options.now ?? Date.now;
  initializeFsSchema(db, now);
  assertComputerImportCurrent(db);

  const ops = createFilesystemOps(db, { now });
  const scanRoots = new Map<string, ReturnType<typeof realpath>>();
  const mutated = (): void => scanRoots.clear();

  const readFiles = (paths: readonly string[], readOptions?: { budget?: number }): ReadBatch => {
    const resolved = realpaths(db, paths);
    const originals = new Map<string, string[]>();
    for (let index = 0; index < paths.length; index++) {
      const input = paths[index];
      const target = resolved[index];
      if (input === undefined || target === undefined) continue;
      const callers = originals.get(target);
      if (callers === undefined) originals.set(target, [input]);
      else callers.push(input);
    }

    const batch = readStoredFiles(db, [...originals.keys()], readOptions);
    const deferredTargets = new Set(batch.remaining);
    let deferredAt = paths.length;
    for (let index = 0; index < resolved.length; index++) {
      const target = resolved[index];
      if (target !== undefined && deferredTargets.has(target)) {
        deferredAt = index;
        break;
      }
    }
    const files = new Map<string, Uint8Array>();
    for (let index = 0; index < deferredAt; index++) {
      const input = paths[index];
      const target = resolved[index];
      if (input === undefined || target === undefined) continue;
      const bytes = batch.files.get(target);
      if (bytes !== undefined) files.set(input, bytes);
    }
    const remaining = paths.slice(deferredAt);
    return { files, remaining };
  };

  return {
    db,
    rev: () => currentRev(db),
    realpath: (path) => realpath(db, path),
    stat: ops.stat,
    statTarget: ops.statTarget,
    exists: ops.exists,
    readFile: ops.readFile,
    readRange: ops.readRange,
    readlink: ops.readlink,
    readdir: ops.readdir,
    scan(root: string, scanOptions: ScanOptions): ScanEntry[] {
      let resolved = scanRoots.get(root);
      if (
        resolved === undefined ||
        (scanOptions.after === undefined && scanOptions.afterSubtree === undefined)
      ) {
        resolved = realpath(db, root);
      }
      const page = scanPage(db, resolved, scanOptions);
      if (page.length < scanOptions.limit) scanRoots.delete(root);
      else scanRoots.set(root, resolved);
      return page;
    },
    discoverFiles: (root, pattern, discoverOptions) =>
      discoverFiles(db, root, pattern, discoverOptions),
    readFileHandles: (handles, handleOptions) => readFileHandles(db, handles, handleOptions),
    readFiles,
    glob: (root, pattern, globOptions) => scanGlob(db, realpath(db, root), pattern, globOptions),
    writeFiles(entries: readonly WriteEntry[], writeOptions?: WriteOptions): void {
      writeStoredFiles(db, entries, writeOptions, now);
      mutated();
    },
    makeDirectories(paths: readonly string[]): void {
      makeStoredDirectories(db, paths, now);
      mutated();
    },
    removeFiles(paths: readonly string[], removeOptions?: RemoveOptions): void {
      removeStoredFiles(db, realpathsNoFollow(db, paths), removeOptions);
      mutated();
    },
    writeFile(path, bytes, writeOptions): void {
      ops.writeFile(path, bytes, writeOptions);
      mutated();
    },
    createFile(path, mode): void {
      ops.createFile(path, mode);
      mutated();
    },
    writeRange(path, bytes, offset): void {
      ops.writeRange(path, bytes, offset);
      mutated();
    },
    truncate(path, length): void {
      ops.truncate(path, length);
      mutated();
    },
    mkdir(path, mkdirOptions): void {
      ops.mkdir(path, mkdirOptions);
      mutated();
    },
    symlink(target, path): void {
      ops.symlink(target, path);
      mutated();
    },
    link(existingPath, newPath): void {
      ops.link(existingPath, newPath);
      mutated();
    },
    unlink(path): void {
      ops.unlink(path);
      mutated();
    },
    rmdir(path): void {
      ops.rmdir(path);
      mutated();
    },
    rm(path, removeOptions): void {
      ops.rm(path, removeOptions);
      mutated();
    },
    rename(oldPath, newPath): void {
      ops.rename(oldPath, newPath);
      mutated();
    },
    chmod(path, mode): void {
      ops.chmod(path, mode);
      mutated();
    },
    withReadScope: (work) => work(),
  };
}
