// The optional working tree adapter, backed by Computer's DOFS provider.
//
// Only the provider's public filesystem surface is used — no reaching into
// the vfs_* tables. Everything is synchronous, which is what makes a
// status walk over thousands of paths affordable.

import { Buffer } from "node:buffer";

import type { SQLiteWorkspaceProvider } from "@cloudflare/computer";
import type { SqlDatabase } from "../../db/db.js";
import { comparePaths, subtreeSuccessor } from "../../fs/path.js";
import {
  DISCOVERY_PAGE_MAX,
  GLOB_PATTERN_MAX_BYTES,
  validateDiscoveryExcludeRoots,
} from "../../fs/store/scan.js";
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
} from "../../fs/types.js";
import { dirnameOf } from "../../git/common/paths.js";
import type { Worktree, WorktreeDirent, WorktreeStat } from "../../git/ops/worktree/worktree.js";
import { globMatcher } from "./worktree-glob.js";
import { readFileHandleBatch, readPathBatch } from "./worktree-reads.js";
import {
  assertRealPath,
  codeOf,
  type DirentLike,
  entryType,
  isExcluded,
  isMissing,
  popCandidate,
  pushCandidate,
  type ScanCandidate,
  statType,
} from "./worktree-support.js";

const EMPTY = Buffer.alloc(0);

export class ComputerWorktree implements Worktree {
  constructor(
    private readonly provider: SQLiteWorkspaceProvider,
    readonly db?: SqlDatabase,
  ) {}

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

  realpath(path: string): RealPath {
    return this.#realpath(path);
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
    if (options.after !== undefined && options.afterSubtree !== undefined) {
      throw new Error("scan: after and afterSubtree are mutually exclusive");
    }
    const canonicalRoot = this.#realpath(root);
    const subtreeBoundary =
      options.afterSubtree === undefined ? undefined : subtreeSuccessor(options.afterSubtree);
    const frontier: ScanCandidate[] = [];
    for (const candidate of this.#children(canonicalRoot)) pushCandidate(frontier, candidate);
    const out: ScanEntry[] = [];
    while (frontier.length > 0 && out.length < options.limit) {
      const candidate = popCandidate(frontier);
      if (candidate === undefined) continue;
      if (
        options.afterSubtree !== undefined &&
        (candidate.path === options.afterSubtree ||
          candidate.path.startsWith(`${options.afterSubtree}/`))
      ) {
        continue;
      }
      const stat = this.stat(candidate.path);
      if (stat === null) continue;
      if (stat.type === "dir") {
        for (const child of this.#children(candidate.path)) pushCandidate(frontier, child);
      }
      if (options.after !== undefined && comparePaths(candidate.path, options.after) <= 0) continue;
      if (subtreeBoundary !== undefined && comparePaths(candidate.path, subtreeBoundary) < 0) {
        continue;
      }
      if (options.filesOnly === true && stat.type === "dir") continue;
      out.push({ path: candidate.path, ...stat });
    }
    return out;
  }

  discoverFiles(
    root: RealPath,
    pattern: string,
    options: DiscoverFilesOptions = {},
  ): DiscoverFilesPage {
    const patternBytes = new TextEncoder().encode(pattern).length;
    if (patternBytes > GLOB_PATTERN_MAX_BYTES) {
      throw new Error(
        `discoverFiles: pattern is ${patternBytes} bytes; the platform caps a GLOB pattern at ${GLOB_PATTERN_MAX_BYTES}`,
      );
    }
    const limit = options.limit ?? DISCOVERY_PAGE_MAX;
    if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_PAGE_MAX) {
      throw new Error(
        `discoverFiles: limit must be an integer from 1 to ${DISCOVERY_PAGE_MAX}, got ${limit}`,
      );
    }
    const match = globMatcher(pattern);
    const canonicalRoot = this.#realpath(root);
    const excluded = validateDiscoveryExcludeRoots(canonicalRoot, options.excludeRoots);
    const frontier: ScanCandidate[] = [];
    for (const candidate of this.#children(canonicalRoot)) pushCandidate(frontier, candidate);
    const out: RegularFileHandle[] = [];
    while (frontier.length > 0 && out.length <= limit) {
      const candidate = popCandidate(frontier);
      if (candidate === undefined || isExcluded(candidate.path, excluded)) continue;
      const stat = this.stat(candidate.path);
      if (stat === null) continue;
      if (stat.type === "dir") {
        for (const child of this.#children(candidate.path)) pushCandidate(frontier, child);
        continue;
      }
      if (options.after !== undefined && comparePaths(candidate.path, options.after) <= 0) continue;
      if (stat.type === "file" && match.test(candidate.path)) {
        const path = this.#canonicalResult(candidate.path);
        out.push({ path, ino: stat.ino, size: stat.size, rev: stat.mtime });
      }
    }
    const handles = out.slice(0, limit);
    return {
      handles,
      next: out.length > limit ? (handles[handles.length - 1]?.path ?? null) : null,
    };
  }

  readFileHandles(
    handles: readonly RegularFileHandle[],
    options: { budget?: number } = {},
  ): HandleReadBatch {
    return readFileHandleBatch(this, handles, options);
  }

  readFiles(paths: readonly string[], options: { budget?: number } = {}): ReadBatch {
    return readPathBatch(this, paths, options);
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

  #canonicalResult(path: string): RealPath {
    // Symlinks were resolved by the provider-backed walk immediately before this assertion.
    assertRealPath(path);
    return path;
  }

  #realpath(path: string): RealPath {
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
    return this.#canonicalResult(resolved.length === 0 ? "/" : `/${resolved.join("/")}`);
  }
}
