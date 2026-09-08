import { normalize } from "../path.js";
import type { ReadBatch, RemoveOptions, WriteEntry } from "../types.js";
import { filesystemError } from "./errors.js";
import { NodeFsPathCompat } from "./node-path.js";
import type {
  CompatWriteFilesEntry,
  CompatWriteFilesOptions,
  NodeRmOptions,
  NodeStats,
  ReadFilesEntry,
  WalkEntry,
  WalkOptions,
} from "./node-types.js";
import {
  checkBufferRange,
  checkPosition,
  countOption,
  isExcluded,
  pathDepth,
  toWalkEntry,
} from "./node-values.js";

export class NodeFsCompat extends NodeFsPathCompat {
  closeSync(fd: number): void {
    if (!this.closeFd(fd)) throw filesystemError("EBADF", "close", undefined, `bad fd ${fd}`);
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
    const state = this.fdState(fd);
    if (!state.readable)
      throw filesystemError("EBADF", "read", undefined, `fd ${fd} is not readable`);
    checkBufferRange(buffer, offset, length, "read");
    const at = position ?? state.position;
    checkPosition(at, "read");
    const bytes = this.filesystem().readRange(state.path, at, length);
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
    const state = this.fdState(fd);
    if (!state.writable)
      throw filesystemError("EBADF", "write", undefined, `fd ${fd} is not writable`);
    checkBufferRange(buffer, offset, length, "write");
    const at = state.append ? this.statSync(state.path).size : (position ?? state.position);
    checkPosition(at, "write");
    const bytes = buffer.subarray(offset, offset + length);
    this.filesystem().writeRange(state.path, bytes, at);
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
    return this.statSync(this.fdState(fd).path);
  }

  fstat(fd: number, options?: { bigint?: boolean }): Promise<NodeStats> {
    return Promise.resolve(this.fstatSync(fd, options));
  }

  ftruncateSync(fd: number, length: number): void {
    const state = this.fdState(fd);
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
    return this.filesystem().readlink(path);
  }

  symlink(target: string, path: string, _type?: string): Promise<void> {
    this.symlinkSync(target, path);
    return Promise.resolve();
  }

  symlinkSync(target: string, path: string, _type?: string): void {
    this.filesystem().symlink(target, path);
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
      const page = this.filesystem().scan(root, { after, limit: 1000 });
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
      const batch: ReadBatch = this.filesystem().readFiles(remaining);
      for (const [path, content] of batch.files) files.set(path, content);
      if (batch.remaining.length >= remaining.length) break;
      remaining = batch.remaining;
    }

    return paths.map((path) => {
      const content = files.get(path);
      if (content !== undefined) return { path: normalize(path), content };
      const stat = this.filesystem().statTarget(path);
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
    this.filesystem().writeFiles(mapped, writeOptions);
    return Promise.resolve();
  }

  rmFiles(paths: readonly string[], options: NodeRmOptions = {}): Promise<void> {
    const mapped: RemoveOptions | undefined =
      options.recursive === undefined && options.force === undefined
        ? undefined
        : { recursive: options.recursive, force: options.force };
    this.filesystem().removeFiles(paths, mapped);
    return Promise.resolve();
  }
}
