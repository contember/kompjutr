// Read-only switch-over aid: answer from the primary filesystem, read the
// same value from the comparison filesystem, and fail on divergence.

import type { Dirent, ReadBatch, RealPath, ScanEntry, ScanOptions, Stat } from "./types.js";

export interface ShadowReadSource {
  rev(): number;
  realpath(path: string): RealPath;
  stat(path: string): Stat | null;
  statTarget(path: string): Stat | null;
  exists(path: string): boolean;
  readFile(path: string): Uint8Array;
  readRange(path: string, offset: number, length: number): Uint8Array;
  readlink(path: string): string;
  readdir(path: string): Dirent[];
  scan(root: string, options: ScanOptions): ScanEntry[];
  readFiles(paths: readonly string[], options?: { budget?: number }): ReadBatch;
  glob(root: string, pattern: string, options?: { limit?: number }): string[];
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

function capture<T>(read: () => T): Outcome<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorIdentity(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code);
  }
  return error instanceof Error ? error.name : typeof error;
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

// Import changes only the inode allocation and per-node revision history.
function statEqual(left: Stat | null, right: Stat | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.type === right.type &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtime === right.mtime &&
    left.nlink === right.nlink &&
    left.target === right.target &&
    bytesEqual(left.contentId, right.contentId)
  );
}

function direntsEqual(left: readonly Dirent[], right: readonly Dirent[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i]?.name !== right[i]?.name || left[i]?.type !== right[i]?.type) return false;
  }
  return true;
}

function stringsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function scansEqual(left: readonly ScanEntry[], right: readonly ScanEntry[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const leftEntry = left[i];
    const rightEntry = right[i];
    if (
      leftEntry === undefined ||
      rightEntry === undefined ||
      leftEntry.path !== rightEntry.path ||
      !statEqual(leftEntry, rightEntry)
    ) {
      return false;
    }
  }
  return true;
}

function batchesEqual(left: ReadBatch, right: ReadBatch): boolean {
  if (!stringsEqual(left.remaining, right.remaining) || left.files.size !== right.files.size) {
    return false;
  }
  for (const [path, leftBytes] of left.files) {
    const rightBytes = right.files.get(path);
    if (rightBytes === undefined || !bytesEqual(leftBytes, rightBytes)) return false;
  }
  return true;
}

function checked<T>(
  call: string,
  primary: () => T,
  comparison: () => T,
  equal: (left: T, right: T) => boolean,
): T {
  const left = capture(primary);
  const right = capture(comparison);
  if (left.ok && right.ok) {
    if (!equal(left.value, right.value)) {
      throw new Error(`shadow read mismatch: ${call} returned different values`);
    }
    return left.value;
  }
  if (!left.ok && !right.ok) {
    if (errorIdentity(left.error) !== errorIdentity(right.error)) {
      throw new Error(`shadow read mismatch: ${call} threw different errors`);
    }
    throw left.error;
  }
  throw new Error(`shadow read mismatch: ${call} succeeded in only one runtime`);
}

/** Compare the complete first-class read surface without exposing mutators. */
export function shadowReads(
  primary: ShadowReadSource,
  comparison: ShadowReadSource,
): ShadowReadSource {
  return {
    rev: () =>
      checked(
        "rev()",
        () => primary.rev(),
        () => comparison.rev(),
        Object.is,
      ),
    realpath: (path) =>
      checked(
        `realpath('${path}')`,
        () => primary.realpath(path),
        () => comparison.realpath(path),
        Object.is,
      ),
    stat: (path) =>
      checked(
        `stat('${path}')`,
        () => primary.stat(path),
        () => comparison.stat(path),
        statEqual,
      ),
    statTarget: (path) =>
      checked(
        `statTarget('${path}')`,
        () => primary.statTarget(path),
        () => comparison.statTarget(path),
        statEqual,
      ),
    exists: (path) =>
      checked(
        `exists('${path}')`,
        () => primary.exists(path),
        () => comparison.exists(path),
        Object.is,
      ),
    readFile: (path) =>
      checked(
        `readFile('${path}')`,
        () => primary.readFile(path),
        () => comparison.readFile(path),
        bytesEqual,
      ),
    readRange: (path, offset, length) =>
      checked(
        `readRange('${path}', ${offset}, ${length})`,
        () => primary.readRange(path, offset, length),
        () => comparison.readRange(path, offset, length),
        bytesEqual,
      ),
    readlink: (path) =>
      checked(
        `readlink('${path}')`,
        () => primary.readlink(path),
        () => comparison.readlink(path),
        Object.is,
      ),
    readdir: (path) =>
      checked(
        `readdir('${path}')`,
        () => primary.readdir(path),
        () => comparison.readdir(path),
        direntsEqual,
      ),
    scan: (root, options) =>
      checked(
        `scan('${root}')`,
        () => primary.scan(root, options),
        () => comparison.scan(root, options),
        scansEqual,
      ),
    readFiles: (paths, options) =>
      checked(
        "readFiles()",
        () => primary.readFiles(paths, options),
        () => comparison.readFiles(paths, options),
        batchesEqual,
      ),
    glob: (root, pattern, options) =>
      checked(
        `glob('${root}', '${pattern}')`,
        () => primary.glob(root, pattern, options),
        () => comparison.glob(root, pattern, options),
        stringsEqual,
      ),
  };
}
