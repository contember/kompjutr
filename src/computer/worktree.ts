// The working tree, backed by Computer's DOFS provider.
//
// Only the provider's public filesystem surface is used — no reaching into
// the vfs_* tables. Everything is synchronous, which is what makes a
// status walk over thousands of paths affordable.

import { Buffer } from "node:buffer";

import type { SQLiteWorkspaceProvider } from "@cloudflare/computer";
import { dirnameOf } from "../core/paths.js";
import type {
  Worktree,
  WorktreeDirent,
  WorktreeEntryType,
  WorktreeStat,
} from "../core/worktree.js";
import { comparePaths } from "../fs/path.js";
import type {
  ReadBatch,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  WriteEntry,
  WriteOptions,
} from "../fs/types.js";

const EMPTY = Buffer.alloc(0);

function statType(stats: { isSymbolicLink(): boolean; isDirectory(): boolean }): WorktreeEntryType {
  if (stats.isSymbolicLink()) return "symlink";
  return stats.isDirectory() ? "dir" : "file";
}

function codeOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return "code" in error ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  const code = codeOf(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

interface DirentLike {
  name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface ScanCandidate {
  path: string;
}

function pushCandidate(heap: ScanCandidate[], candidate: ScanCandidate): void {
  heap.push(candidate);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentEntry = heap[parent];
    if (parentEntry === undefined || comparePaths(parentEntry.path, candidate.path) <= 0) break;
    heap[index] = parentEntry;
    index = parent;
  }
  heap[index] = candidate;
}

function popCandidate(heap: ScanCandidate[]): ScanCandidate | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === undefined || heap.length === 0) return first;

  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    let child = left;
    const leftEntry = heap[left];
    const rightEntry = heap[right];
    if (
      rightEntry !== undefined &&
      leftEntry !== undefined &&
      comparePaths(rightEntry.path, leftEntry.path) < 0
    ) {
      child = right;
    }
    const childEntry = heap[child];
    if (childEntry === undefined || comparePaths(last.path, childEntry.path) <= 0) break;
    heap[index] = childEntry;
    index = child;
  }
  heap[index] = last;
  return first;
}

/**
 * dofs's `wrapDirent` hardcodes `isSymbolicLink: () => false` and derives
 * `isFile` from `type === "file"`, so a symlink answers false to all three
 * predicates. An inconclusive dirent therefore gets one `lstat` to settle
 * it — which only happens for symlinks, leaving the walk's hot path alone.
 */
function entryType(entry: DirentLike): WorktreeEntryType | null {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "dir";
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
        nlink: stats.nlink,
        rev: 0,
        target: stats.isSymbolicLink() ? this.provider.readlinkSync(path) : null,
        contentId: null,
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

  writeFile(
    path: string,
    data: Uint8Array,
    options: { mode?: number; contentId?: Uint8Array } = {},
  ): void {
    this.#mkdirp(dirnameOf(path));
    this.provider.writeFileSync(path, Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      mode: options.mode,
    });
  }

  readlink(path: string): string {
    return this.provider.readlinkSync(path);
  }

  symlink(target: string, path: string): void {
    this.#mkdirp(dirnameOf(path));
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

  #mkdirp(path: string): void {
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

  readRange(path: string, offset: number, length: number): Uint8Array {
    return this.provider.readRangeSync(path, offset, length);
  }

  createFile(path: string, mode: number): void {
    this.#mkdirp(dirnameOf(path));
    try {
      this.provider.createFileSync(path, { mode });
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      // createFileSync only creates; truncating an existing path is ours to supply.
      this.provider.writeFileSync(path, EMPTY, { mode });
    }
  }

  writeRange(path: string, data: Uint8Array, offset: number): void {
    this.provider.writeRangeSync(path, data, offset);
  }

  scan(root: string, options: ScanOptions): ScanEntry[] {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error(`scan: limit must be a positive integer, got ${options.limit}`);
    }
    const canonicalRoot = this.#realpath(root);
    const frontier: ScanCandidate[] = [];
    for (const candidate of this.#children(canonicalRoot)) pushCandidate(frontier, candidate);
    const out: ScanEntry[] = [];
    while (frontier.length > 0 && out.length < options.limit) {
      const candidate = popCandidate(frontier);
      if (candidate === undefined) continue;
      const stat = this.stat(candidate.path);
      if (stat === null) continue;
      if (stat.type === "dir") {
        for (const child of this.#children(candidate.path)) pushCandidate(frontier, child);
      }
      if (options.after !== undefined && comparePaths(candidate.path, options.after) <= 0) continue;
      if (options.filesOnly === true && stat.type === "dir") continue;
      out.push({ path: candidate.path, ...stat });
    }
    return out;
  }

  readFiles(paths: readonly string[], options: { budget?: number } = {}): ReadBatch {
    const budget = options.budget ?? 1_500_000;
    const files = new Map<string, Uint8Array>();
    const remaining: string[] = [];
    let bytes = 0;
    for (const path of paths) {
      const stat = this.stat(path);
      if (stat?.type !== "file") continue;
      if (files.size > 0 && bytes + stat.size > budget) {
        remaining.push(path);
        continue;
      }
      const contents = this.readFile(path);
      files.set(path, contents);
      bytes += contents.byteLength;
    }
    return { files, remaining };
  }

  glob(root: string, pattern: string, options: { limit?: number } = {}): string[] {
    const match = globMatcher(pattern);
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    const out: string[] = [];
    let after: string | undefined;
    while (out.length < limit) {
      const page = this.scan(root, { after, limit: 1_000 });
      if (page.length === 0) break;
      for (const entry of page) {
        if (match.test(entry.path)) out.push(entry.path);
        if (out.length >= limit) break;
      }
      after = page[page.length - 1]?.path;
      if (page.length < 1_000) break;
    }
    return out;
  }

  writeFiles(entries: readonly WriteEntry[], options: WriteOptions = {}): void {
    const createParents = options.parents !== false;
    for (const entry of [...entries].sort((left, right) => comparePaths(left.path, right.path))) {
      if (createParents) this.#mkdirp(dirnameOf(entry.path));
      if (entry.target !== undefined) {
        this.#remove(entry.path, true, true);
        this.provider.symlinkSync(entry.target, entry.path);
      } else if (entry.bytes !== undefined) {
        this.writeFile(entry.path, entry.bytes, { mode: entry.mode });
      } else {
        this.provider.mkdirSync(entry.path, { recursive: createParents, mode: entry.mode });
      }
    }
  }

  makeDirectories(paths: readonly string[]): void {
    for (const path of paths) this.#mkdirp(path);
  }

  removeFiles(paths: readonly string[], options: RemoveOptions = {}): void {
    for (const path of paths) {
      this.#remove(path, options.recursive ?? false, options.force ?? true);
    }
  }

  #remove(path: string, recursive: boolean, force: boolean): void {
    const stat = this.stat(path);
    if (stat === null) {
      if (!force)
        throw Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
          code: "ENOENT",
        });
      return;
    }
    if (stat.type !== "dir") {
      this.provider.unlinkSync(path);
      return;
    }
    const entries = this.readdir(path);
    if (!recursive && entries.length > 0) {
      throw Object.assign(new Error(`ENOTEMPTY: directory not empty, '${path}'`), {
        code: "ENOTEMPTY",
      });
    }
    for (const entry of entries) {
      this.#remove(path === "/" ? `/${entry.name}` : `${path}/${entry.name}`, true, false);
    }
    this.provider.rmdirSync(path);
  }

  #children(directory: string): ScanCandidate[] {
    let entries: string[] | DirentLike[];
    try {
      entries = this.provider.readdirSync(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return entries.map((entry) => {
      const name = typeof entry === "string" ? entry : entry.name;
      return { path: directory === "/" ? `/${name}` : `${directory}/${name}` };
    });
  }

  #realpath(path: string): string {
    let resolved: string[] = [];
    let pending = path.replace(/^\/+/, "").split("/");
    let follows = 0;
    let missingPrefix: string | undefined;
    for (let index = 0; index < pending.length; index++) {
      const component = pending[index];
      if (component === undefined) continue;
      const current = resolved.length === 0 ? "/" : `/${resolved.join("/")}`;
      const currentStat = this.stat(current);
      if (currentStat !== null && currentStat.type !== "dir") {
        throw Object.assign(new Error(`ENOTDIR: not a directory, '${path}'`), {
          code: "ENOTDIR",
        });
      }
      if (component === "" || component === ".") continue;
      if (component === "..") {
        if (missingPrefix !== undefined) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, '${missingPrefix}'`), {
            code: "ENOENT",
          });
        }
        resolved.pop();
        continue;
      }
      resolved.push(component);
      const candidate = `/${resolved.join("/")}`;
      const stat = this.stat(candidate);
      if (stat === null && missingPrefix === undefined) missingPrefix = candidate;
      if (stat?.type !== "symlink") continue;
      if (follows++ >= 40) {
        throw Object.assign(new Error(`ELOOP: too many symbolic links, '${path}'`), {
          code: "ELOOP",
        });
      }
      const target = this.readlink(candidate);
      resolved.pop();
      if (target.startsWith("/")) resolved = [];
      pending = [...target.replace(/^\/+/, "").split("/"), ...pending.slice(index + 1)];
      missingPrefix = undefined;
      index = -1;
    }
    return resolved.length === 0 ? "/" : `/${resolved.join("/")}`;
  }
}

function globMatcher(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0) source += "\\[";
      else {
        const contents = pattern.slice(index + 1, end);
        source += `[${contents.startsWith("^") ? `\\${contents}` : contents}]`;
        index = end;
      }
    } else source += character?.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") ?? "";
  }
  return new RegExp(`${source}$`, "u");
}
