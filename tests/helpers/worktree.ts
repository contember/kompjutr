// Worktree decorators shared by the op tests.

import type {
  DiscoverFilesOptions,
  DiscoverFilesPage,
  HandleReadBatch,
  ReadBatch,
  RealPath,
  RegularFileHandle,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  WriteEntry,
  WriteOptions,
} from "../../src/fs/types.js";
import type { Worktree, WorktreeDirent, WorktreeStat } from "../../src/git/ops/worktree.js";

/** Counts the calls that would mean a file was read to be hashed. */
export class CountingWorktree implements Worktree {
  reads = 0;
  bulkReadPaths: string[] = [];
  /** Ranged reads, which hash a file without ever holding all of it. */
  rangeReads = 0;
  rangeWrites = 0;
  creates = 0;
  /** Directory listings, which is how a lazy walk shows it is lazy. */
  readdirs = 0;

  constructor(private readonly inner: Worktree) {}

  stat(path: string): WorktreeStat | null {
    return this.inner.stat(path);
  }
  realpath(path: string): RealPath {
    return this.inner.realpath(path);
  }
  readFile(path: string): Uint8Array {
    this.reads++;
    return this.inner.readFile(path);
  }
  writeFile(
    path: string,
    data: Uint8Array,
    options?: { mode?: number; contentId?: Uint8Array },
  ): void {
    this.inner.writeFile(path, data, options);
  }
  readlink(path: string): string {
    this.reads++;
    return this.inner.readlink(path);
  }
  symlink(target: string, path: string): void {
    this.inner.symlink(target, path);
  }
  readdir(path: string): WorktreeDirent[] {
    this.readdirs++;
    return this.inner.readdir(path);
  }
  unlink(path: string): void {
    this.inner.unlink(path);
  }
  rmdir(path: string): void {
    this.inner.rmdir(path);
  }
  chmod(path: string, mode: number): void {
    this.inner.chmod(path, mode);
  }
  readRange(path: string, offset: number, length: number): Uint8Array {
    this.rangeReads++;
    return this.inner.readRange(path, offset, length);
  }
  createFile(path: string, mode: number): void {
    this.creates++;
    this.inner.createFile(path, mode);
  }
  writeRange(path: string, data: Uint8Array, offset: number): void {
    this.rangeWrites++;
    this.inner.writeRange(path, data, offset);
  }
  scan(root: string, options: ScanOptions): ScanEntry[] {
    return this.inner.scan(root, options);
  }
  discoverFiles(
    root: RealPath,
    pattern: string,
    options?: DiscoverFilesOptions,
  ): DiscoverFilesPage {
    return this.inner.discoverFiles(root, pattern, options);
  }
  readFileHandles(
    handles: readonly RegularFileHandle[],
    options?: { budget?: number },
  ): HandleReadBatch {
    this.reads += handles.length;
    return this.inner.readFileHandles(handles, options);
  }
  readFiles(paths: readonly string[], options?: { budget?: number }): ReadBatch {
    const batch = this.inner.readFiles(paths, options);
    this.bulkReadPaths.push(...batch.files.keys());
    return batch;
  }
  glob(root: string, pattern: string, options?: { limit?: number }): string[] {
    return this.inner.glob(root, pattern, options);
  }
  writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void {
    this.inner.writeFiles(entries, options);
  }
  makeDirectories(paths: readonly string[]): void {
    this.inner.makeDirectories(paths);
  }
  removeFiles(paths: readonly string[], options?: RemoveOptions): void {
    this.inner.removeFiles(paths, options);
  }
}
