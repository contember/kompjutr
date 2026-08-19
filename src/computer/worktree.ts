// The working tree, backed by Computer's DOFS provider.
//
// Only the provider's public filesystem surface is used — no reaching into
// the vfs_* tables. Everything is synchronous, which is what makes a
// status walk over thousands of paths affordable.

import { Buffer } from "node:buffer";

import type { SQLiteWorkspaceProvider } from "@cloudflare/computer";

import type { Worktree, WorktreeDirent, WorktreeEntryType, WorktreeStat } from "../core/worktree.js";
import { dirnameOf } from "../core/paths.js";

function statType(stats: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}): WorktreeEntryType {
  if (stats.isSymbolicLink()) return "symlink";
  return stats.isDirectory() ? "directory" : "file";
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

interface DirentLike {
  name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * dofs's `wrapDirent` hardcodes `isSymbolicLink: () => false` and derives
 * `isFile` from `type === "file"`, so a symlink answers false to all three
 * predicates. An inconclusive dirent therefore gets one `lstat` to settle
 * it — which only happens for symlinks, leaving the walk's hot path alone.
 */
function entryType(entry: DirentLike): WorktreeEntryType | null {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return null;
}

export class ComputerWorktree implements Worktree {
  constructor(private readonly provider: SQLiteWorkspaceProvider) {}

  stat(path: string): WorktreeStat | null {
    try {
      const stats = this.provider.lstatSync(path);
      return {
        type: statType(stats),
        mode: stats.mode,
        size: stats.size,
        mtime: stats.mtimeMs,
        ino: stats.ino,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  readFile(path: string): Uint8Array {
    const contents = this.provider.readFileSync(path);
    if (typeof contents === "string") return new TextEncoder().encode(contents);
    return contents;
  }

  writeFile(path: string, data: Uint8Array, mode: number): void {
    this.mkdirp(dirnameOf(path));
    this.provider.writeFileSync(path, Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      mode,
    });
  }

  readlink(path: string): string {
    return this.provider.readlinkSync(path);
  }

  symlink(target: string, path: string): void {
    this.mkdirp(dirnameOf(path));
    this.provider.symlinkSync(target, path);
  }

  readdir(path: string): WorktreeDirent[] {
    let entries: string[] | DirentLike[];
    try {
      entries = this.provider.readdirSync(path, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const prefix = path === "/" ? "" : path;
    const out: WorktreeDirent[] = [];
    for (const entry of entries) {
      if (typeof entry === "string") {
        out.push({ name: entry, type: this.stat(`${prefix}/${entry}`)?.type ?? "file" });
        continue;
      }
      const type = entryType(entry) ?? this.stat(`${prefix}/${entry.name}`)?.type ?? "file";
      out.push({ name: entry.name, type });
    }
    return out;
  }

  mkdirp(path: string): void {
    if (path === "/" || path === "") return;
    this.provider.mkdirSync(path, { recursive: true });
  }

  unlink(path: string): void {
    try {
      this.provider.unlinkSync(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  rmdir(path: string): void {
    try {
      this.provider.rmdirSync(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  chmod(path: string, mode: number): void {
    this.provider.chmodSync(path, mode);
  }
}
