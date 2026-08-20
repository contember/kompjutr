// Worktree decorators shared by the op tests.

import type { Worktree, WorktreeDirent, WorktreeStat } from "../../src/core/worktree.js";
import type {
  ReadBatch,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  WriteEntry,
  WriteOptions,
} from "../../src/fs/types.js";

/** Counts the calls that would mean a file was read to be hashed. */
export class CountingWorktree implements Worktree {
  reads = 0;
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
  readFiles(paths: readonly string[], options?: { budget?: number }): ReadBatch {
    return this.inner.readFiles(paths, options);
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
