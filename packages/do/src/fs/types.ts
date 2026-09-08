// The filesystem the git layer talks to. Two layers live above these
// types: `Filesystem` is first-class — path-based, synchronous, bulk-first
// — and the node:fs-shaped surface is a shim over it.
//
// Nothing here knows about git. The dependency runs one way.

import type {
  ContentSearchOptions,
  ContentSearchPage,
  CopyBatch,
  CopyEntry,
  CopyOptions,
  Dirent,
  DiscoverFilesOptions,
  DiscoverFilesPage,
  GitDrive,
  GlobOptions,
  GlobPage,
  HandleReadBatch,
  ListOptions,
  ListPage,
  ReadBatch,
  ReadOptions,
  RealPath,
  RegularFileHandle,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  Stat,
  StreamWriteOptions,
  TouchOptions,
  WriteEntry,
  WriteOptions,
} from "@kompjutr/drive";
import type { SqlDatabase } from "../db/db.js";

export type {
  ContentSearchOptions,
  ContentSearchPage,
  CopyBatch,
  CopyEntry,
  CopyOptions,
  Dirent,
  DiscoverFilesOptions,
  DiscoverFilesPage,
  EntryType,
  GitDrive,
  GlobOptions,
  GlobPage,
  HandleReadBatch,
  ListCursor,
  ListItem,
  ListOptions,
  ListPage,
  ReadBatch,
  ReadOptions,
  RealPath,
  RegularFileHandle,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  Stat,
  StreamWriteOptions,
  TouchOptions,
  WriteEntry,
  WriteOptions,
} from "@kompjutr/drive";

export interface FilesystemOptions {
  /** Milliseconds. Injected so a test can pin `mtime`. Defaults to `Date.now`. */
  now?: () => number;
}

export interface Filesystem extends GitDrive {
  /** The database this filesystem lives in. Shared with the git layer. */
  readonly db: SqlDatabase;
  readonly mutationScope?: object;

  // -- identity ------------------------------------------------------

  /** Monotonic revision, bumped once per mutating call. One statement. */
  rev(): number;

  /**
   * Canonicalise and resolve every symlink on the path. One statement in
   * the common case, one more per symlink encountered.
   */
  realpath(path: string): RealPath;

  // -- single-path reads ---------------------------------------------

  /** lstat semantics: a symlink reports as a symlink. `null` when absent. */
  stat(path: string): Stat | null;
  /** stat semantics: follows a trailing symlink. */
  statTarget(path: string): Stat | null;
  exists(path: string): boolean;
  readFile(path: string): Uint8Array;
  /** Up to `length` bytes at `offset`. Short only at EOF. */
  readRange(path: string, offset: number, length: number): Uint8Array;
  readlink(path: string): string;
  readdir(path: string): Dirent[];

  // -- bulk reads. This is why the runtime exists. -------------------

  /**
   * One page of everything under `root`, in path byte order — the order
   * `comparePaths` defines, which is git's tree order.
   *
   * ONE statement per page: an indexed range scan on `fs_paths`, not a
   * traversal. The merge joins above this layer consume it directly.
   */
  scan(root: string, options: ScanOptions): ScanEntry[];

  /**
   * Discover regular files only, without following matching symlinks.
   * `root` is resolved once by the caller. One indexed statement.
   */
  discoverFiles(root: RealPath, pattern: string, options?: DiscoverFilesOptions): DiscoverFilesPage;

  /**
   * Discover regular files whose *content* contains `needle`, as one indexed
   * statement. The bytes of a file that cannot match never reach the
   * isolate, which is the difference that matters on a Durable Object.
   *
   * `needle` is compared byte for byte against the stored BLOBs, so it
   * carries no encoding assumption. See `ContentSearchPage.undecided` for
   * the one case the database cannot settle.
   */
  discoverFilesContaining(
    root: RealPath,
    pattern: string,
    needle: Uint8Array,
    options?: ContentSearchOptions,
  ): ContentSearchPage;

  /** Read discovered files without another path-resolution or metadata lookup. */
  readFileHandles(
    handles: readonly RegularFileHandle[],
    options?: { budget?: number },
  ): HandleReadBatch;

  /** Several files in one round trip, under a byte budget. */
  readFiles(paths: readonly string[], options?: ReadOptions): ReadBatch;

  /**
   * Every path under `root` matching a glob, in path order. One statement.
   * The platform caps a GLOB pattern at 50 bytes.
   */
  glob(root: string, pattern: string, options?: { limit?: number }): string[];

  /** A completeness-bearing, keyset-paged glob for bounded consumers. */
  globPage(root: string, pattern: string, options?: GlobOptions): GlobPage;

  /** Metadata-bearing directory groups for long and recursive listings. */
  listEntries(root: string, options?: ListOptions): ListPage;

  // -- bulk writes ---------------------------------------------------

  /**
   * Create or overwrite many entries. Directories, files and symlinks may
   * be mixed; entries are applied in path order so a parent always lands
   * before its children.
   */
  writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void;

  /** Copy entries inside SQLite; file BLOBs never enter the isolate. */
  copyFiles(entries: readonly CopyEntry[], options?: CopyOptions): CopyBatch;

  /** Update timestamps as one preflighted mutation without reading content. */
  touchFiles(paths: readonly string[], options?: TouchOptions): void;

  /** Atomically stream a regular-file write without retaining the full content. */
  writeFileStream(path: string, chunks: Iterable<Uint8Array>, options?: StreamWriteOptions): void;

  /** Create directories, parents included. Existing ones are left alone. */
  makeDirectories(paths: readonly string[]): void;

  /**
   * Remove many paths. A recursive removal is a range delete, so removing
   * a 5,000-file tree costs what removing one file costs.
   */
  removeFiles(paths: readonly string[], options?: RemoveOptions): void;

  // -- single-path writes: wrappers over the bulk primitives ---------

  writeFile(
    path: string,
    bytes: Uint8Array,
    options?: { mode?: number; contentId?: Uint8Array },
  ): void;
  /** Create or truncate, ready for writeRange. Creates parents. */
  createFile(path: string, mode: number): void;
  /** Write at `offset`. The file must exist. Clears `contentId`. */
  writeRange(path: string, bytes: Uint8Array, offset: number): void;
  truncate(path: string, length: number): void;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  symlink(target: string, path: string): void;
  /** A second name for one inode. */
  link(existingPath: string, newPath: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  rm(path: string, options?: RemoveOptions): void;
  rename(oldPath: string, newPath: string): void;
  chmod(path: string, mode: number): void;

  // -- scopes --------------------------------------------------------

  /**
   * Bracket a batch of reads. Ships as a pass-through: over a path-keyed
   * table a lookup is one indexed read, so there is nothing to memoise.
   * Declared because removing it later would break callers and adding
   * memoisation later will not.
   */
  withReadScope<T>(fn: () => T): T;
}

export { S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from "@kompjutr/drive";
