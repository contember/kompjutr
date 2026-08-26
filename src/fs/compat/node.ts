import { Buffer } from "node:buffer";

import { normalize } from "../path.js";
import type {
  Dirent,
  Filesystem,
  ReadBatch,
  RemoveOptions,
  ScanEntry,
  Stat,
  WriteEntry,
} from "../types.js";
import { filesystemError } from "./errors.js";

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

type ReadFileOptions = BufferEncoding | { encoding?: BufferEncoding | null } | null;
type WriteFileOptions = BufferEncoding | { encoding?: BufferEncoding; mode?: number };
type MkdirOptions = { recursive?: boolean; mode?: number };
type NodeRmOptions = { recursive?: boolean; force?: boolean };
type TimeLike = number | string | Date;

interface FdState {
  path: string;
  position: number;
  readable: boolean;
  writable: boolean;
  append: boolean;
}

interface ParsedFlags {
  read: boolean;
  write: boolean;
  create: boolean;
  truncate: boolean;
  append: boolean;
  exclusive: boolean;
}

/** node:fs-shaped compatibility surface over the path-first filesystem. */
export class NodeFsCompat {
  readonly db;
  readonly readonly = false;
  readonly supportsSymlinks = true;
  readonly supportsWatch = false;

  #fds = new Map<number, FdState>();
  #nextFd = 3;

  constructor(private readonly fs: Filesystem) {
    this.db = fs.db;
  }

  open(path: string, flags?: string, mode?: number): Promise<number> {
    return Promise.resolve(this.openSync(path, flags, mode));
  }

  openSync(path: string, flags = "r", mode = 0o666): number {
    const parsed = parseFlags(flags);
    const link = this.fs.stat(path);
    const target = this.fs.statTarget(path);

    if (target === null) {
      if (!parsed.create) throw filesystemError("ENOENT", "open", path, "no such file");
      if (link !== null) throw filesystemError("ENOENT", "open", path, "dangling symbolic link");
      this.fs.createFile(path, mode);
    } else {
      if (target.type !== "file") {
        throw filesystemError("EISDIR", "open", path, "path is a directory");
      }
      if (parsed.exclusive) throw filesystemError("EEXIST", "open", path, "path exists");
      if (parsed.truncate) this.fs.truncate(path, 0);
    }

    const opened = this.fs.statTarget(path);
    if (opened === null) throw filesystemError("ENOENT", "open", path, "no such file");
    const fd = this.#nextFd++;
    this.#fds.set(fd, {
      path,
      position: parsed.append ? opened.size : 0,
      readable: parsed.read,
      writable: parsed.write,
      append: parsed.append,
    });
    return fd;
  }

  stat(path: string, options?: { bigint?: boolean }): Promise<NodeStats> {
    return Promise.resolve(this.statSync(path, options));
  }

  statSync(path: string, _options?: { bigint?: boolean }): NodeStats {
    const stat = this.fs.statTarget(path);
    if (stat === null) throw filesystemError("ENOENT", "stat", path, "no such file or directory");
    return wrapStats(stat);
  }

  lstat(path: string, options?: { bigint?: boolean }): Promise<NodeStats> {
    return Promise.resolve(this.lstatSync(path, options));
  }

  lstatSync(path: string, _options?: { bigint?: boolean }): NodeStats {
    const stat = this.fs.stat(path);
    if (stat === null) throw filesystemError("ENOENT", "lstat", path, "no such file or directory");
    return wrapStats(stat);
  }

  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: false }): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<NodeDirent[]>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[] | NodeDirent[]> {
    const entries = this.fs.readdir(path);
    return Promise.resolve(
      options?.withFileTypes === true
        ? entries.map((entry) => wrapDirent(path, entry))
        : entries.map((entry) => entry.name),
    );
  }

  readdirSync(path: string): string[];
  readdirSync(path: string, options: { withFileTypes: false }): string[];
  readdirSync(path: string, options: { withFileTypes: true }): NodeDirent[];
  readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | NodeDirent[] {
    const entries = this.fs.readdir(path);
    if (options?.withFileTypes === true) return entries.map((entry) => wrapDirent(path, entry));
    return entries.map((entry) => entry.name);
  }

  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined> {
    return Promise.resolve(this.mkdirSync(path, options));
  }

  mkdirSync(path: string, options: MkdirOptions = {}): string | undefined {
    this.fs.mkdir(path, options);
    return undefined;
  }

  rmdir(path: string): Promise<void> {
    this.rmdirSync(path);
    return Promise.resolve();
  }

  rmdirSync(path: string): void {
    this.fs.rmdir(path);
  }

  rm(path: string, options?: NodeRmOptions): Promise<void> {
    this.rmSync(path, options);
    return Promise.resolve();
  }

  rmSync(path: string, options: NodeRmOptions = {}): void {
    this.fs.rm(path, {
      recursive: options.recursive ?? false,
      force: options.force ?? false,
    });
  }

  unlink(path: string): Promise<void> {
    this.unlinkSync(path);
    return Promise.resolve();
  }

  unlinkSync(path: string): void {
    this.fs.unlink(path);
  }

  link(existingPath: string, newPath: string): Promise<void> {
    this.linkSync(existingPath, newPath);
    return Promise.resolve();
  }

  linkSync(existingPath: string, newPath: string): void {
    this.fs.link(existingPath, newPath);
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    this.renameSync(oldPath, newPath);
    return Promise.resolve();
  }

  renameSync(oldPath: string, newPath: string): void {
    this.fs.rename(oldPath, newPath);
  }

  readFile(path: string, options?: ReadFileOptions): Promise<Buffer | string> {
    return Promise.resolve(this.readFileSync(path, options));
  }

  readFileSync(path: string, options?: ReadFileOptions): Buffer | string {
    const encoding = typeof options === "string" ? options : options?.encoding;
    const bytes = this.fs.readFile(path);
    const buffer = Buffer.from(bytes);
    return encoding === undefined || encoding === null ? buffer : buffer.toString(encoding);
  }

  writeFile(path: string, data: string | Uint8Array, options?: WriteFileOptions): Promise<void> {
    this.writeFileSync(path, data, options);
    return Promise.resolve();
  }

  writeFileSync(path: string, data: string | Uint8Array, options?: WriteFileOptions): void {
    const encoding = typeof options === "string" ? options : options?.encoding;
    const mode = typeof options === "string" ? undefined : options?.mode;
    const bytes = typeof data === "string" ? Buffer.from(data, encoding) : data;
    this.fs.writeFile(path, bytes, { mode });
  }

  createFileSync(path: string, options: { mode?: number } = {}): void {
    this.fs.createFile(path, options.mode ?? 0o644);
  }

  createFile(path: string, options: { mode?: number } = {}): Promise<void> {
    this.createFileSync(path, options);
    return Promise.resolve();
  }

  readRangeSync(path: string, offset: number, length: number): Buffer {
    return Buffer.from(this.fs.readRange(path, offset, length));
  }

  readRange(path: string, offset: number, length: number): Promise<Buffer> {
    return Promise.resolve(this.readRangeSync(path, offset, length));
  }

  writeRangeSync(
    path: string,
    data: string | Uint8Array,
    offset: number,
    options?: WriteFileOptions,
  ): number {
    const encoding = typeof options === "string" ? options : options?.encoding;
    const bytes = typeof data === "string" ? Buffer.from(data, encoding) : data;
    this.fs.writeRange(path, bytes, offset);
    return bytes.byteLength;
  }

  writeRange(
    path: string,
    data: string | Uint8Array,
    offset: number,
    options?: WriteFileOptions,
  ): Promise<number> {
    return Promise.resolve(this.writeRangeSync(path, data, offset, options));
  }

  truncateFileSync(path: string, length: number): void {
    this.truncateSync(path, length);
  }

  truncateFile(path: string, length: number): Promise<void> {
    this.truncateFileSync(path, length);
    return Promise.resolve();
  }

  truncateSync(path: string, length: number): void {
    this.fs.truncate(path, length);
  }

  truncate(path: string, length: number): Promise<void> {
    this.truncateSync(path, length);
    return Promise.resolve();
  }

  chmodSync(path: string, mode: number): void {
    this.fs.chmod(path, mode);
  }

  chmod(path: string, mode: number): Promise<void> {
    this.chmodSync(path, mode);
    return Promise.resolve();
  }

  utimesSync(path: string, _atime: TimeLike, mtime: TimeLike): void {
    this.fs.touchFiles([path], { create: false, mtime: timeMilliseconds(mtime, "utimes") });
  }

  utimes(path: string, atime: TimeLike, mtime: TimeLike): Promise<void> {
    this.utimesSync(path, atime, mtime);
    return Promise.resolve();
  }

  futimesSync(fd: number, _atime: TimeLike, mtime: TimeLike): void {
    this.fs.touchFiles([this.#fd(fd).path], {
      create: false,
      mtime: timeMilliseconds(mtime, "futimes"),
    });
  }

  futimes(fd: number, atime: TimeLike, mtime: TimeLike): Promise<void> {
    this.futimesSync(fd, atime, mtime);
    return Promise.resolve();
  }

  appendFileSync(_path: string, _data: string | Uint8Array, _options?: WriteFileOptions): void {
    throw filesystemError("ENOSYS", "appendFile", undefined, "operation not implemented");
  }

  appendFile(path: string, data: string | Uint8Array, options?: WriteFileOptions): Promise<void> {
    try {
      this.appendFileSync(path, data, options);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  copyFileSync(source: string, destination: string, mode = 0): void {
    const stat = this.fs.statTarget(source);
    if (stat === null) throw filesystemError("ENOENT", "copyFile", source, "no such file");
    if (stat.type !== "file") {
      throw filesystemError("EISDIR", "copyFile", source, "source is not a regular file");
    }
    if ((mode & 1) !== 0 && this.fs.stat(destination) !== null) {
      throw filesystemError("EEXIST", "copyFile", destination, "destination exists");
    }
    const batch = this.fs.copyFiles([{ source: this.fs.realpath(source), destination }], {
      parents: false,
    });
    if (batch.remaining.length > 0) {
      throw filesystemError("EIO", "copyFile", source, "copy made no progress");
    }
  }

  copyFile(source: string, destination: string, mode?: number): Promise<void> {
    try {
      this.copyFileSync(source, destination, mode);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  internalModuleStat(_path: string): number {
    throw filesystemError("ENOSYS", "internalModuleStat", undefined, "operation not implemented");
  }

  watchFile(_path: string): never {
    throw filesystemError("ENOSYS", "watchFile", undefined, "operation not implemented");
  }

  unwatchFile(_path: string): never {
    throw filesystemError("ENOSYS", "unwatchFile", undefined, "operation not implemented");
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.existsSync(path));
  }

  existsSync(path: string): boolean {
    try {
      return this.fs.exists(path);
    } catch {
      return false;
    }
  }

  realpath(path: string): Promise<string> {
    return Promise.resolve(this.realpathSync(path));
  }

  realpathSync(path: string): string {
    const real = this.fs.realpath(path);
    if (this.fs.statTarget(real) === null) {
      throw filesystemError("ENOENT", "realpath", path, "no such file or directory");
    }
    return real;
  }

  access(path: string, _mode?: number): Promise<void> {
    this.accessSync(path);
    return Promise.resolve();
  }

  accessSync(path: string, _mode?: number): void {
    if (this.fs.statTarget(path) === null) {
      throw filesystemError("ENOENT", "access", path, "no such file or directory");
    }
  }

  closeSync(fd: number): void {
    if (!this.#fds.delete(fd)) throw filesystemError("EBADF", "close", undefined, `bad fd ${fd}`);
  }

  close(fd: number): Promise<void> {
    this.closeSync(fd);
    return Promise.resolve();
  }

  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    const state = this.#fd(fd);
    if (!state.readable)
      throw filesystemError("EBADF", "read", undefined, `fd ${fd} is not readable`);
    checkBufferRange(buffer, offset, length, "read");
    const at = position ?? state.position;
    checkPosition(at, "read");
    const bytes = this.fs.readRange(state.path, at, length);
    buffer.set(bytes, offset);
    if (position === null) state.position = at + bytes.byteLength;
    return bytes.byteLength;
  }

  read(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    return Promise.resolve({
      bytesRead: this.readSync(fd, buffer, offset, length, position),
      buffer,
    });
  }

  writeSync(
    fd: number,
    buffer: Uint8Array,
    offset = 0,
    length = buffer.byteLength - offset,
    position: number | null = null,
  ): number {
    const state = this.#fd(fd);
    if (!state.writable)
      throw filesystemError("EBADF", "write", undefined, `fd ${fd} is not writable`);
    checkBufferRange(buffer, offset, length, "write");
    const at = state.append ? this.statSync(state.path).size : (position ?? state.position);
    checkPosition(at, "write");
    const bytes = buffer.subarray(offset, offset + length);
    this.fs.writeRange(state.path, bytes, at);
    if (position === null) state.position = at + length;
    return length;
  }

  write(
    fd: number,
    buffer: Uint8Array,
    offset = 0,
    length = buffer.byteLength - offset,
    position: number | null = null,
  ): Promise<{ bytesWritten: number; buffer: Uint8Array }> {
    return Promise.resolve({
      bytesWritten: this.writeSync(fd, buffer, offset, length, position),
      buffer,
    });
  }

  fstatSync(fd: number, _options?: { bigint?: boolean }): NodeStats {
    return this.statSync(this.#fd(fd).path);
  }

  fstat(fd: number, options?: { bigint?: boolean }): Promise<NodeStats> {
    return Promise.resolve(this.fstatSync(fd, options));
  }

  ftruncateSync(fd: number, length: number): void {
    const state = this.#fd(fd);
    if (!state.writable) {
      throw filesystemError("EBADF", "ftruncate", undefined, `fd ${fd} is not writable`);
    }
    this.truncateSync(state.path, length);
  }

  ftruncate(fd: number, length: number): Promise<void> {
    this.ftruncateSync(fd, length);
    return Promise.resolve();
  }

  readlink(path: string): Promise<string> {
    return Promise.resolve(this.readlinkSync(path));
  }

  readlinkSync(path: string): string {
    return this.fs.readlink(path);
  }

  symlink(target: string, path: string, _type?: string): Promise<void> {
    this.symlinkSync(target, path);
    return Promise.resolve();
  }

  symlinkSync(target: string, path: string, _type?: string): void {
    this.fs.symlink(target, path);
  }

  async walk(directory: string, options: WalkOptions = {}): Promise<WalkEntry[]> {
    const depth = countOption(options.depth, "depth") ?? Number.MAX_SAFE_INTEGER;
    const offset = countOption(options.offset, "offset") ?? 0;
    const limit = countOption(options.limit, "limit") ?? Number.MAX_SAFE_INTEGER;
    if (limit === 0) return [];

    const root = normalize(this.realpathSync(directory));
    const rootDepth = pathDepth(root);
    const excluded = new Set(options.exclude ?? []);
    const out: WalkEntry[] = [];
    let seen = 0;
    let after: string | undefined;

    while (out.length < limit) {
      const page = this.fs.scan(root, { after, limit: 1000 });
      if (page.length === 0) break;
      for (const entry of page) {
        const relativeDepth = pathDepth(entry.path) - rootDepth;
        if (
          relativeDepth > depth ||
          isExcluded(entry.path, root, excluded, options.excludeHidden)
        ) {
          continue;
        }
        if (seen++ < offset) continue;
        out.push(toWalkEntry(entry));
        if (out.length >= limit) break;
      }
      after = page[page.length - 1]?.path;
      if (page.length < 1000) break;
    }
    return out;
  }

  async readFiles(paths: readonly string[]): Promise<ReadFilesEntry[]> {
    const files = new Map<string, Uint8Array>();
    let remaining = [...paths];
    while (remaining.length > 0) {
      const batch: ReadBatch = this.fs.readFiles(remaining);
      for (const [path, content] of batch.files) files.set(path, content);
      if (batch.remaining.length >= remaining.length) break;
      remaining = batch.remaining;
    }

    return paths.map((path) => {
      const content = files.get(path);
      if (content !== undefined) return { path: normalize(path), content };
      const stat = this.fs.statTarget(path);
      return {
        path: normalize(path),
        error: stat?.type === "dir" ? "EISDIR" : "ENOENT",
      };
    });
  }

  writeFiles(
    entries: readonly CompatWriteFilesEntry[],
    options: CompatWriteFilesOptions = {},
  ): Promise<void> {
    const mapped: WriteEntry[] = entries.map((entry) => ({
      path: entry.path,
      bytes:
        typeof entry.content === "string" ? new TextEncoder().encode(entry.content) : entry.content,
      mode: entry.mode,
    }));
    const writeOptions =
      options.createParents === undefined ? undefined : { parents: options.createParents };
    this.fs.writeFiles(mapped, writeOptions);
    return Promise.resolve();
  }

  rmFiles(paths: readonly string[], options: NodeRmOptions = {}): Promise<void> {
    const mapped: RemoveOptions | undefined =
      options.recursive === undefined && options.force === undefined
        ? undefined
        : { recursive: options.recursive, force: options.force };
    this.fs.removeFiles(paths, mapped);
    return Promise.resolve();
  }

  #fd(fd: number): FdState {
    const state = this.#fds.get(fd);
    if (state === undefined) throw filesystemError("EBADF", "fd", undefined, `bad fd ${fd}`);
    return state;
  }
}

function wrapStats(stat: Stat): NodeStats {
  const time = new Date(stat.mtime);
  return {
    dev: 0,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 4096,
    ino: stat.ino,
    size: stat.size,
    blocks: Math.ceil(stat.size / 512),
    atimeMs: stat.mtime,
    mtimeMs: stat.mtime,
    ctimeMs: stat.mtime,
    birthtimeMs: stat.mtime,
    atime: time,
    mtime: time,
    ctime: time,
    birthtime: time,
    isFile: () => stat.type === "file",
    isDirectory: () => stat.type === "dir",
    isSymbolicLink: () => stat.type === "symlink",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function wrapDirent(parentPath: string, entry: Dirent): NodeDirent {
  const parent = normalize(parentPath);
  return {
    name: entry.name,
    parentPath: parent,
    path: parent === "/" ? `/${entry.name}` : `${parent}/${entry.name}`,
    isFile: () => entry.type === "file",
    isDirectory: () => entry.type === "dir",
    isSymbolicLink: () => entry.type === "symlink",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

function parseFlags(flags: string): ParsedFlags {
  switch (flags) {
    case "r":
      return {
        read: true,
        write: false,
        create: false,
        truncate: false,
        append: false,
        exclusive: false,
      };
    case "r+":
      return {
        read: true,
        write: true,
        create: false,
        truncate: false,
        append: false,
        exclusive: false,
      };
    case "w":
      return {
        read: false,
        write: true,
        create: true,
        truncate: true,
        append: false,
        exclusive: false,
      };
    case "w+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: true,
        append: false,
        exclusive: false,
      };
    case "wx":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: false,
        exclusive: true,
      };
    case "wx+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: false,
        exclusive: true,
      };
    case "a":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: false,
      };
    case "a+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: false,
      };
    case "ax":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: true,
      };
    case "ax+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: true,
      };
    default:
      throw filesystemError("EINVAL", "open", undefined, `unsupported flag ${flags}`);
  }
}

function checkBufferRange(
  buffer: Uint8Array,
  offset: number,
  length: number,
  syscall: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.byteLength
  ) {
    throw filesystemError("EINVAL", syscall, undefined, "invalid buffer range");
  }
}

function checkPosition(position: number, syscall: string): void {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw filesystemError("EINVAL", syscall, undefined, "invalid position");
  }
}

function countOption(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`walk ${name} must be a non-negative safe integer`);
  return value;
}

function timeMilliseconds(value: TimeLike, syscall: string): number {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value) * 1_000;
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(Math.trunc(milliseconds))) {
    throw filesystemError("EINVAL", syscall, undefined, "invalid time");
  }
  return Math.trunc(milliseconds);
}

function pathDepth(path: string): number {
  if (path === "/") return 0;
  return path.split("/").length - 1;
}

function isExcluded(
  path: string,
  root: string,
  excluded: ReadonlySet<string>,
  excludeHidden = false,
): boolean {
  const relative = root === "/" ? path.slice(1) : path.slice(root.length + 1);
  for (const segment of relative.split("/")) {
    if (excluded.has(segment) || (excludeHidden && segment.startsWith("."))) return true;
  }
  return false;
}

function toWalkEntry(entry: ScanEntry): WalkEntry {
  return {
    path: entry.path,
    type: entry.type,
    mode: entry.mode & 0o7777,
    mtime: entry.mtime,
    size: entry.size,
    ...(entry.target === null ? {} : { linkTarget: entry.target }),
  };
}
