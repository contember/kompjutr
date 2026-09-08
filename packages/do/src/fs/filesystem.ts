import type { SqlDatabase } from "../db/db.js";
import { filesystemError } from "./errors.js";
import { assertComputerImportCurrent } from "./import.js";
import { createFilesystemOps } from "./ops.js";
import { initializeFsSchema } from "./schema.js";
import { COPY_ENTRY_LIMIT, copyFiles as copyStoredFiles } from "./store/copy.js";
import { currentRev } from "./store/meta.js";
import { registerNativeOwnedReads } from "./store/owned-read.js";
import { readFileHandles, readFiles as readStoredFiles } from "./store/read.js";
import { removeFiles as removeStoredFiles } from "./store/remove.js";
import { realpath, realpaths, realpathsNoFollow } from "./store/resolve.js";
import {
  discoverFiles,
  glob as scanGlob,
  globPage as scanGlobPage,
  listEntries as scanListEntries,
  scan as scanPage,
} from "./store/scan.js";
import { discoverFilesContaining } from "./store/search.js";
import { writeFileStream as writeStoredStream } from "./store/stream-write.js";
import { TOUCH_PATH_LIMIT, touchFiles as touchStoredFiles } from "./store/touch.js";
import {
  makeDirectories as makeStoredDirectories,
  writeFiles as writeStoredFiles,
} from "./store/write.js";
import type {
  ContentSearchOptions,
  ContentSearchPage,
  CopyBatch,
  CopyEntry,
  CopyOptions,
  Filesystem,
  FilesystemOptions,
  GlobOptions,
  GlobPage,
  ListOptions,
  ListPage,
  ReadBatch,
  ReadOptions,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  StreamWriteOptions,
  TouchOptions,
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
  const globRoots = new Map<string, ReturnType<typeof realpath>>();
  const listRoots = new Map<string, ReturnType<typeof realpath>>();
  const mutated = (): void => {
    scanRoots.clear();
    globRoots.clear();
    listRoots.clear();
  };

  const readFiles = (paths: readonly string[], readOptions?: ReadOptions): ReadBatch => {
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

  const filesystem: Filesystem = {
    db,
    mutationScope: db.mutationScope ?? db,
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
    discoverFilesContaining: (
      root,
      pattern,
      needle,
      searchOptions?: ContentSearchOptions,
    ): ContentSearchPage => discoverFilesContaining(db, root, pattern, needle, searchOptions),
    readFileHandles: (handles, handleOptions) => readFileHandles(db, handles, handleOptions),
    readFiles,
    glob: (root, pattern, globOptions) => scanGlob(db, realpath(db, root), pattern, globOptions),
    globPage(root: string, pattern: string, globOptions: GlobOptions = {}): GlobPage {
      let resolved = globRoots.get(root);
      if (resolved === undefined || globOptions.after === undefined) resolved = realpath(db, root);
      const page = scanGlobPage(db, resolved, pattern, globOptions);
      if (page.next === null) globRoots.delete(root);
      else globRoots.set(root, resolved);
      return page;
    },
    listEntries(root: string, listOptions: ListOptions = {}): ListPage {
      let resolved = listRoots.get(root);
      if (resolved === undefined || listOptions.after === undefined) resolved = realpath(db, root);
      const page = scanListEntries(db, resolved, listOptions);
      if (page.next === null) listRoots.delete(root);
      else listRoots.set(root, resolved);
      return page;
    },
    writeFiles(entries: readonly WriteEntry[], writeOptions?: WriteOptions): void {
      writeStoredFiles(db, entries, writeOptions, now);
      mutated();
    },
    copyFiles(entries: readonly CopyEntry[], copyOptions?: CopyOptions): CopyBatch {
      const page = entries.slice(0, COPY_ENTRY_LIMIT);
      const sources = realpathsNoFollow(
        db,
        page.map((entry) => entry.source),
      );
      const destinations = realpathsNoFollow(
        db,
        page.map((entry) => entry.destination),
      );
      const resolved = [];
      for (let index = 0; index < page.length; index++) {
        const source = sources[index];
        const destination = destinations[index];
        if (source === undefined || destination === undefined) {
          throw new Error("copyFiles: path resolution returned an incomplete batch");
        }
        resolved.push({ source, destination });
      }
      const copied = copyStoredFiles(db, resolved, copyOptions, now);
      if (copied > 0) mutated();
      return { copied, remaining: entries.slice(copied) };
    },
    touchFiles(paths: readonly string[], touchOptions: TouchOptions = {}): void {
      if (paths.length > TOUCH_PATH_LIMIT) {
        throw filesystemError("E2BIG", `touch accepts at most ${TOUCH_PATH_LIMIT} paths`);
      }
      touchStoredFiles(db, realpaths(db, paths), touchOptions.mtime ?? now(), touchOptions.create);
      if (paths.length > 0) mutated();
    },
    writeFileStream(
      path: string,
      chunks: Iterable<Uint8Array>,
      streamOptions: StreamWriteOptions = {},
    ): void {
      writeStoredStream(db, realpath(db, path), chunks, streamOptions.append === true, now());
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
  registerNativeOwnedReads(filesystem, db);
  return filesystem;
}
