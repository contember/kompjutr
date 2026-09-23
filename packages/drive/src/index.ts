export type EntryType = "file" | "dir" | "symlink";

/** A canonical path resolved through every ancestor symlink. */
export type RealPath = string & { readonly __real: unique symbol };

export interface Stat {
  type: EntryType;
  mode: number;
  size: number;
  mtime: number;
  ino: number;
  nlink: number;
  rev: number;
  target: string | null;
  /** Equal non-null IDs prove equal bytes; null requires content hashing. */
  contentId: Uint8Array | null;
}

export interface Dirent {
  name: string;
  type: EntryType;
}

export interface ScanEntry extends Stat {
  path: string;
}

export interface ScanOptions {
  after?: string;
  afterSubtree?: string;
  limit: number;
  filesOnly?: boolean;
}

export interface GlobOptions {
  after?: string;
  limit?: number;
}

export interface GlobPage {
  paths: string[];
  next: string | null;
}

export interface ListCursor {
  directory: string;
  path: string | null;
}

export interface ListOptions {
  after?: ListCursor;
  limit?: number;
  recursive?: boolean;
}

export interface ListItem {
  directory: string;
  entry: ScanEntry | null;
}

export interface ListPage {
  items: ListItem[];
  next: ListCursor | null;
}

export interface RegularFileHandle {
  path: RealPath;
  ino: number;
  size: number;
  rev: number;
}

export interface DiscoverFilesOptions {
  after?: RealPath;
  limit?: number;
  excludeRoots?: readonly string[];
}

export interface DiscoverFilesPage {
  handles: RegularFileHandle[];
  next: RealPath | null;
}

export interface ContentSearchOptions {
  after?: RealPath;
  limit?: number;
  excludeBinary?: boolean;
}

export interface ContentSearchPage {
  matched: RegularFileHandle[];
  undecided: RegularFileHandle[];
  next: RealPath | null;
}

export interface HandleReadBatch {
  files: Map<RealPath, Uint8Array>;
  remaining: RegularFileHandle[];
}

export interface ReadBatch {
  files: Map<string, Uint8Array>;
  remaining: string[];
}

export interface ReadOptions {
  budget?: number;
  maxBytes?: number;
  deferOversized?: boolean;
}

export interface WriteEntry {
  path: string;
  bytes?: Uint8Array;
  target?: string;
  mode?: number;
  mtime?: number;
  contentId?: Uint8Array;
}

export interface WriteOptions {
  parents?: boolean;
  payloadBudget?: number;
}

export interface CopyEntry {
  source: string;
  destination: string;
}

export interface CopyOptions {
  parents?: boolean;
  budget?: number;
}

export interface CopyBatch {
  copied: number;
  remaining: CopyEntry[];
}

export interface TouchOptions {
  mtime?: number;
  create?: boolean;
}

export interface StreamWriteOptions {
  append?: boolean;
}

export interface RemoveOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface OrderedScanOptions {
  filesOnly?: boolean;
  /** Start strictly after this path. */
  after?: string;
  /**
   * Called after a directory row is yielded and before its descendants are
   * read. A files-only scan may yield no directory rows, so callers that need
   * the exclusion still filter.
   */
  pruneDirectory?: (path: string) => boolean;
}

/** The synchronous bulk-first drive surface consumed by the Git engine. */
export interface GitDrive {
  readonly mutationScope?: object;
  stat(path: string): Stat | null;
  realpath(path: string): RealPath;
  readFile(path: string): Uint8Array;
  readRange(path: string, offset: number, length: number): Uint8Array;
  readFileStream?(path: string, expected: Stat): Iterable<Uint8Array>;
  readlink(path: string): string;
  readdir(path: string): Dirent[];
  scan(root: string, options: ScanOptions): ScanEntry[];
  /** Everything under `root` in `comparePaths` order, streamed in bounded memory. */
  scanStream(root: RealPath, options?: OrderedScanOptions): Iterable<ScanEntry>;
  discoverFiles(root: RealPath, pattern: string, options?: DiscoverFilesOptions): DiscoverFilesPage;
  readFileHandles(
    handles: readonly RegularFileHandle[],
    options?: { budget?: number },
  ): HandleReadBatch;
  readFiles(paths: readonly string[], options?: ReadOptions): ReadBatch;
  glob(root: string, pattern: string, options?: { limit?: number }): string[];
  writeFile(
    path: string,
    bytes: Uint8Array,
    options?: { mode?: number; contentId?: Uint8Array },
  ): void;
  createFile(path: string, mode: number): void;
  writeRange(path: string, bytes: Uint8Array, offset: number): void;
  symlink(target: string, path: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  chmod(path: string, mode: number): void;
  writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void;
  makeDirectories(paths: readonly string[]): void;
  removeFiles(paths: readonly string[], options?: RemoveOptions): void;
}

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;
