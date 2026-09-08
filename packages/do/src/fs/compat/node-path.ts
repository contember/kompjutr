import { Buffer } from "node:buffer";

import type { Filesystem } from "../types.js";
import { filesystemError } from "./errors.js";
import type {
  CompatBufferEncoding,
  FdState,
  MkdirOptions,
  NodeDirent,
  NodeRmOptions,
  NodeStats,
  ReadFileOptions,
  TimeLike,
  WriteFileOptions,
} from "./node-types.js";
import { parseFlags, timeMilliseconds, wrapDirent, wrapStats } from "./node-values.js";

function encodeString(data: string, encoding: CompatBufferEncoding | undefined): Uint8Array {
  const bytes: unknown = Buffer.from(data, encoding);
  if (bytes instanceof Uint8Array) return bytes;
  throw new TypeError("Buffer.from did not return a Uint8Array");
}

/** node:fs-shaped compatibility surface over the path-first filesystem. */
export class NodeFsPathCompat {
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

  readFile(path: string, options?: ReadFileOptions): Promise<Uint8Array | string> {
    return Promise.resolve(this.readFileSync(path, options));
  }

  readFileSync(path: string, options?: ReadFileOptions): Uint8Array | string {
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
    if (typeof data === "string") {
      this.fs.writeFile(path, encodeString(data, encoding), { mode });
      return;
    }
    this.fs.writeFile(path, data, { mode });
  }

  createFileSync(path: string, options: { mode?: number } = {}): void {
    this.fs.createFile(path, options.mode ?? 0o644);
  }

  createFile(path: string, options: { mode?: number } = {}): Promise<void> {
    this.createFileSync(path, options);
    return Promise.resolve();
  }

  readRangeSync(path: string, offset: number, length: number): Uint8Array {
    return Buffer.from(this.fs.readRange(path, offset, length));
  }

  readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    return Promise.resolve(this.readRangeSync(path, offset, length));
  }

  writeRangeSync(
    path: string,
    data: string | Uint8Array,
    offset: number,
    options?: WriteFileOptions,
  ): number {
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (typeof data === "string") {
      const bytes = encodeString(data, encoding);
      this.fs.writeRange(path, bytes, offset);
      return bytes.byteLength;
    }
    this.fs.writeRange(path, data, offset);
    return data.byteLength;
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
    this.fs.touchFiles([this.fdState(fd).path], {
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

  protected fdState(fd: number): FdState {
    const state = this.#fds.get(fd);
    if (state === undefined) throw filesystemError("EBADF", "fd", undefined, `bad fd ${fd}`);
    return state;
  }

  protected closeFd(fd: number): boolean {
    return this.#fds.delete(fd);
  }

  protected filesystem(): Filesystem {
    return this.fs;
  }
}
