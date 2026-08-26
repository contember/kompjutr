// The filesystem the git layer talks to. Two layers live above these
// types: `Filesystem` is first-class — path-based, synchronous, bulk-first
// — and the node:fs-shaped surface is a shim over it.
//
// Nothing here knows about git. The dependency runs one way.

import type { SqlDatabase } from "../sqlite/db.js";

export type EntryType = "file" | "dir" | "symlink";

/**
 * A path that is canonical AND resolved through every symlink on the way.
 * The only key `fs_paths` ever holds.
 *
 * The brand exists so a lexical path cannot reach the store by accident:
 * if `/a` is a symlink to `/b`, then `/a/c` must be stored as `/b/c`, or
 * the row shadows its own target. `realpath()` is the sole producer.
 */
export type RealPath = string & { readonly __real: unique symbol };

export interface Stat {
  type: EntryType;
  /** Full st_mode, S_IF* bits included. */
  mode: number;
  size: number;
  /** Milliseconds. */
  mtime: number;
  ino: number;
  nlink: number;
  /** `fs_meta.rev` as of this entry's last mutation. */
  rev: number;
  /** Symlinks only. */
  target: string | null;
  /**
   * Opaque content identity. Equal ids mean equal bytes. `null` means the
   * store cannot say and the content has to be read to be identified.
   *
   * The filesystem never computes one. A writer that already knows an
   * identity passes it in; git passes the blob oid it already has.
   */
  contentId: Uint8Array | null;
}

export interface Dirent {
  name: string;
  type: EntryType;
}

/** One row of a bulk scan: the dirent and its stat, together. */
export interface ScanEntry extends Stat {
  /** Absolute, canonical, real. */
  path: string;
}

export interface ScanOptions {
  /**
   * Resume strictly after this path.
   */
  after?: string;
  /**
   * Resume at the first path after this directory's subtree. Unlike passing
   * `subtreeSuccessor(dir)` as `after`, this includes an exact sibling at the
   * successor key. Mutually exclusive with `after`.
   */
  afterSubtree?: string;
  /** Hard cap on rows returned. The caller pages. */
  limit: number;
  /** Omit directory rows. Files and symlinks only. */
  filesOnly?: boolean;
}

export interface GlobOptions {
  /** Resume strictly after this canonical path. */
  after?: string;
  /** Defaults to 1,000 and cannot exceed 1,000. */
  limit?: number;
}

export interface GlobPage {
  paths: string[];
  /** Re-call with this cursor. `null` proves this was the final page. */
  next: string | null;
}

export interface ListCursor {
  directory: string;
  /** Null is the synthetic row for an empty directory. */
  path: string | null;
}

export interface ListOptions {
  after?: ListCursor;
  /** Defaults to 1,000 and cannot exceed 1,000. */
  limit?: number;
  /** Include every descendant directory group. Default false. */
  recursive?: boolean;
}

export interface ListItem {
  /** The directory whose output group this row belongs to. */
  directory: string;
  /** Null proves the directory exists but has no children. */
  entry: ScanEntry | null;
}

export interface ListPage {
  items: ListItem[];
  /** Re-call with this cursor. `null` proves this was the final page. */
  next: ListCursor | null;
}

/** A regular file proven to have contiguous content at discovery time. */
export interface RegularFileHandle {
  /** Absolute, canonical, real path. */
  path: RealPath;
  ino: number;
  size: number;
  /** Node revision used to reject stale handles before returning bytes. */
  rev: number;
}

export interface DiscoverFilesOptions {
  /** Resume strictly after this canonical handle path. */
  after?: RealPath;
  /** Defaults to 1,000 and cannot exceed 1,000. */
  limit?: number;
}

export interface DiscoverFilesPage {
  handles: RegularFileHandle[];
  /** Re-call with this cursor. `null` proves this was the final page. */
  next: RealPath | null;
}

export interface ContentSearchOptions {
  /** Resume strictly after this canonical handle path. */
  after?: RealPath;
  /** Defaults to 1,000 and cannot exceed 1,000. */
  limit?: number;
  /**
   * Drop files holding a NUL byte, the way a search that walks a tree skips
   * binaries. Decided in SQL for the same reason the needle is: a caller
   * that had to read each file to find out would give the push-down back.
   * Only settles single-chunk files; larger ones stay `undecided`.
   */
  excludeBinary?: boolean;
}

export interface ContentSearchPage {
  /**
   * Files the database proved contain the needle. Their bytes were never
   * read into the isolate to decide it.
   */
  matched: RegularFileHandle[];
  /**
   * Files spanning more than one chunk. A needle can straddle a chunk
   * boundary, so `instr` cannot rule them out and the caller must read and
   * check them. Reporting them beats dropping them: a missed file is a
   * silently wrong search.
   */
  undecided: RegularFileHandle[];
  /** Re-call with this cursor. `null` proves this was the final page. */
  next: RealPath | null;
}

export interface HandleReadBatch {
  /** Bytes keyed by the canonical path carried by each handle. */
  files: Map<RealPath, Uint8Array>;
  /** Handles deferred by the byte budget, in input order. */
  remaining: RegularFileHandle[];
}

export interface ReadBatch {
  /** Bytes, keyed by path. A path that has gone missing is absent. */
  files: Map<string, Uint8Array>;
  /**
   * Set when the byte budget stopped the batch early. Re-call with the
   * remaining paths. Never partial *within* a file.
   */
  remaining: string[];
}

export interface WriteEntry {
  path: string;
  /** Omit for a directory or when `target` is set. */
  bytes?: Uint8Array;
  /** Set to write a symlink. */
  target?: string;
  /** Permission bits. Defaults to 0o644 for files, 0o755 for directories. */
  mode?: number;
  /** Milliseconds. Defaults to the filesystem's clock. */
  mtime?: number;
  /** Opaque content identity to record. Omitted means NULL — unknown. */
  contentId?: Uint8Array;
}

export interface WriteOptions {
  /** Create missing parent directories. Default true. */
  parents?: boolean;
  /** Bytes per SQL statement. Default 1 MiB; hard ceiling 2 MB. */
  payloadBudget?: number;
}

export interface CopyEntry {
  source: string;
  destination: string;
}

export interface CopyOptions {
  /** Create missing destination parents. Default true. */
  parents?: boolean;
  /** Maximum regular-file bytes selected for this call. Default 1.5 MiB. */
  budget?: number;
}

export interface CopyBatch {
  /** Input entries copied by this call, in input order. */
  copied: number;
  /** Re-call with these entries to complete the request. */
  remaining: CopyEntry[];
}

export interface TouchOptions {
  /** Milliseconds. Defaults to the filesystem clock. */
  mtime?: number;
  /** Create missing regular files. Default true. */
  create?: boolean;
}

export interface RemoveOptions {
  /** Remove directories and everything under them. Default false. */
  recursive?: boolean;
  /** A path that is not there is not an error. Default true. */
  force?: boolean;
}

export interface FilesystemOptions {
  /** Milliseconds. Injected so a test can pin `mtime`. Defaults to `Date.now`. */
  now?: () => number;
}

export interface Filesystem {
  /** The database this filesystem lives in. Shared with the git layer. */
  readonly db: SqlDatabase;

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
  readFiles(paths: readonly string[], options?: { budget?: number }): ReadBatch;

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

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;
