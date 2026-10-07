import type { SqlDatabase } from "../db/db.js";
import { filesystemError } from "./errors.js";
import { assertComputerImportCurrent } from "./import.js";
import { ResolvedRoots, registerFilesystem } from "./internals.js";
import { createFilesystemOps } from "./ops.js";
import { initializeFsSchema } from "./schema.js";
import { COPY_ENTRY_LIMIT, copyFiles as copyStoredFiles } from "./store/copy.js";
import { currentRev } from "./store/meta.js";
import { readResolvedFiles } from "./store/read/read-resolved.js";
import { readFileHandles } from "./store/read.js";
import { removeFiles as removeStoredFiles } from "./store/remove.js";
import { realpath, realpaths, realpathsNoFollow } from "./store/resolve.js";
import { scanStream } from "./store/scan/scan-stream.js";
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
  let epoch = 0;
  const currentEpoch = (): number => epoch;
  const mutated = (): void => {
    epoch++;
  };
  const scanRoots = new ResolvedRoots(currentEpoch);
  const globRoots = new ResolvedRoots(currentEpoch);
  const listRoots = new ResolvedRoots(currentEpoch);

  const readFiles = (paths: readonly string[], readOptions?: ReadOptions): ReadBatch =>
    readResolvedFiles(db, paths, realpaths(db, paths), readOptions);

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
      scanRoots.keep(root, resolved, page.length >= scanOptions.limit);
      return page;
    },
    scanStream: (root, streamOptions) => scanStream(db, root, streamOptions),
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
      globRoots.keep(root, resolved, page.next !== null);
      return page;
    },
    listEntries(root: string, listOptions: ListOptions = {}): ListPage {
      let resolved = listRoots.get(root);
      if (resolved === undefined || listOptions.after === undefined) resolved = realpath(db, root);
      const page = scanListEntries(db, resolved, listOptions);
      listRoots.keep(root, resolved, page.next !== null);
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
  registerFilesystem(filesystem, { db, now, mutated, epoch: currentEpoch });
  return filesystem;
}
