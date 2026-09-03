export interface NodeStats {
  dev: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  blksize: number;
  ino: number;
  size: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

export interface NodeDirent {
  name: string;
  parentPath: string;
  /** Kept for compatibility with Computer's provider. */
  path: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

export interface WalkEntry {
  path: string;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  linkTarget?: string;
}

export interface WalkOptions {
  depth?: number;
  limit?: number;
  offset?: number;
  exclude?: readonly string[];
  excludeHidden?: boolean;
}

export interface ReadFilesEntry {
  path: string;
  content?: Uint8Array;
  error?: "ENOENT" | "EISDIR" | "EIO";
}

export interface CompatWriteFilesEntry {
  path: string;
  content: Uint8Array | string;
  mode?: number;
}

export interface CompatWriteFilesOptions {
  createParents?: boolean;
}

export type ReadFileOptions = BufferEncoding | { encoding?: BufferEncoding | null } | null;
export type WriteFileOptions = BufferEncoding | { encoding?: BufferEncoding; mode?: number };
export type MkdirOptions = { recursive?: boolean; mode?: number };
export type NodeRmOptions = { recursive?: boolean; force?: boolean };
export type TimeLike = number | string | Date;

export interface FdState {
  path: string;
  position: number;
  readable: boolean;
  writable: boolean;
  append: boolean;
}

export interface ParsedFlags {
  read: boolean;
  write: boolean;
  create: boolean;
  truncate: boolean;
  append: boolean;
  exclusive: boolean;
}
