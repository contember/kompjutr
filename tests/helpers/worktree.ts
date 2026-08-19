// Worktree decorators shared by the op tests.

import type { Worktree, WorktreeDirent, WorktreeStat } from "../../src/core/worktree.js";

/** Counts the calls that would mean a file was read to be hashed. */
export class CountingWorktree implements Worktree {
  reads = 0;
  /** Ranged reads, which hash a file without ever holding all of it. */
  rangeReads = 0;
  rangeWrites = 0;
  creates = 0;

  constructor(private readonly inner: Worktree) {}

  stat(path: string): WorktreeStat | null {
    return this.inner.stat(path);
  }
  readFile(path: string): Uint8Array {
    this.reads++;
    return this.inner.readFile(path);
  }
  writeFile(path: string, data: Uint8Array, mode: number): void {
    this.inner.writeFile(path, data, mode);
  }
  readlink(path: string): string {
    this.reads++;
    return this.inner.readlink(path);
  }
  symlink(target: string, path: string): void {
    this.inner.symlink(target, path);
  }
  readdir(path: string): WorktreeDirent[] {
    return this.inner.readdir(path);
  }
  mkdirp(path: string): void {
    this.inner.mkdirp(path);
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
}
