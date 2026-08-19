// The working tree, backed by Computer's DOFS provider.
//
// Only the provider's public filesystem surface is used — no reaching into
// the vfs_* tables. Everything is synchronous, which is what makes a
// status walk over thousands of paths affordable.

import { Buffer } from "node:buffer";

import type { SQLiteWorkspaceProvider } from "@cloudflare/computer";

import type { Worktree, WorktreeDirent, WorktreeEntryType, WorktreeStat } from "../core/worktree.js";
import { dirnameOf } from "../core/paths.js";

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function entryType(entry: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}): WorktreeEntryType {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  return "file";
}

export class ComputerWorktree implements Worktree {
  constructor(private readonly provider: SQLiteWorkspaceProvider) {}

  stat(path: string): WorktreeStat | null {
    try {
      const stats = this.provider.lstatSync(path);
      return {
        type: entryType(stats),
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
    let entries: string[] | { name: string; isSymbolicLink(): boolean; isDirectory(): boolean }[];
    try {
      entries = this.provider.readdirSync(path, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const out: WorktreeDirent[] = [];
    for (const entry of entries) {
      if (typeof entry === "string") {
        const stats = this.stat(`${path === "/" ? "" : path}/${entry}`);
        out.push({ name: entry, type: stats?.type ?? "file" });
      } else {
        out.push({ name: entry.name, type: entryType(entry) });
      }
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
