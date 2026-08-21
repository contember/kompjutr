// The optional working tree adapter, backed by Computer's DOFS provider.
//
// Only the provider's public filesystem surface is used — no reaching into
// the vfs_* tables. Everything is synchronous, which is what makes a
// status walk over thousands of paths affordable.

import { Buffer } from "node:buffer";

import type { SQLiteWorkspaceProvider } from "@cloudflare/computer";
import { dirnameOf } from "../../core/paths.js";
import type {
  Worktree,
  WorktreeDirent,
  WorktreeEntryType,
  WorktreeStat,
} from "../../core/worktree.js";
import { comparePaths, normalize, subtreeSuccessor } from "../../fs/path.js";
import { CHUNK_SIZE } from "../../fs/schema.js";
import { MAX_HANDLE_MATERIALIZE_BYTES } from "../../fs/store/read.js";
import { DISCOVERY_PAGE_MAX, GLOB_PATTERN_MAX_BYTES } from "../../fs/store/scan.js";
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

const MAX_PATH_CODE_UNITS = 4096;
const MAX_HANDLE_COUNT = 5_000;

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

function assertRealPath(path: string): asserts path is RealPath {
  if (!path.startsWith("/") || normalize(path) !== path || path.length > MAX_PATH_CODE_UNITS) {
    throw new Error(`Computer returned an invalid canonical path: '${path}'`);
  }
}

function validateHandleInputs(handles: readonly RegularFileHandle[]): void {
  if (handles.length > MAX_HANDLE_COUNT) {
    throw new Error(`readFileHandles: at most ${MAX_HANDLE_COUNT} handles may be read at once`);
  }
  for (let index = 0; index < handles.length; index++) {
    const handle = handles[index];
    if (handle === undefined) continue;
    if (
      typeof handle.path !== "string" ||
      handle.path.length > MAX_PATH_CODE_UNITS ||
      !handle.path.startsWith("/") ||
      normalize(handle.path) !== handle.path
    ) {
      throw new Error(`readFileHandles: handle ${index} has an invalid canonical path`);
    }
    if (
      !Number.isSafeInteger(handle.ino) ||
      !Number.isSafeInteger(handle.size) ||
      handle.size < 0 ||
      !Number.isSafeInteger(handle.rev)
    ) {
      throw new Error(`readFileHandles: handle ${index} has invalid metadata`);
    }
  }
}

function appendRemaining(
  out: RegularFileHandle[],
  handles: readonly RegularFileHandle[],
  from: number,
): void {
  for (let index = from; index < handles.length; index++) {
    const handle = handles[index];
    if (handle !== undefined) out.push(handle);
  }
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
    const match = globMatcher(pattern);
    const limit = options.limit ?? DISCOVERY_PAGE_MAX;
    if (!Number.isInteger(limit) || limit < 1 || limit > DISCOVERY_PAGE_MAX) {
      throw new Error(
        `discoverFiles: limit must be an integer from 1 to ${DISCOVERY_PAGE_MAX}, got ${limit}`,
      );
    }
    const out: RegularFileHandle[] = [];
    let after: string | undefined = options.after;
    while (out.length <= limit) {
      const page = this.scan(root, { after, filesOnly: true, limit: 1_000 });
      if (page.length === 0) break;
      for (const entry of page) {
        if (entry.type === "file" && match.test(entry.path)) {
          const path = this.#canonicalResult(entry.path);
          out.push({ path, ino: entry.ino, size: entry.size, rev: entry.mtime });
        }
        if (out.length > limit) break;
      }
      if (out.length > limit) break;
      after = page[page.length - 1]?.path;
      if (page.length < 1_000) break;
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
    const budget = options.budget ?? 1_500_000;
    if (!(budget > 0)) throw new Error("readFileHandles: budget must be positive");
    if (budget > 1_500_000) {
      throw new Error("readFileHandles: budget must not exceed 1500000 bytes");
    }
    validateHandleInputs(handles);
    const files = new Map<RealPath, Uint8Array>();
    const remaining: RegularFileHandle[] = [];
    const pending: RegularFileHandle[] = [];
    let plannedBytes = 0;
    for (let index = 0; index < handles.length; index++) {
      const handle = handles[index];
      if (handle === undefined) continue;
      if (pending.length > 0 && plannedBytes + handle.size > budget) {
        appendRemaining(remaining, handles, index);
        break;
      }
      pending.push(handle);
      plannedBytes += handle.size;
      if (handle.size > budget) {
        appendRemaining(remaining, handles, index + 1);
        break;
      }
    }

    const stats = new Map<RealPath, WorktreeStat>();
    for (const handle of pending) {
      const stat = this.stat(handle.path);
      if (
        stat?.type !== "file" ||
        stat.ino !== handle.ino ||
        stat.size !== handle.size ||
        stat.mtime !== handle.rev
      ) {
        throw Object.assign(new Error(`ESTALE: file handle is stale, '${handle.path}'`), {
          code: "ESTALE",
        });
      }
      if (stat.size > MAX_HANDLE_MATERIALIZE_BYTES) {
        throw Object.assign(
          new Error(
            `EFBIG: '${handle.path}' is ${stat.size} bytes; handle reads are capped at ${MAX_HANDLE_MATERIALIZE_BYTES}`,
          ),
          { code: "EFBIG" },
        );
      }
      stats.set(handle.path, stat);
    }

    for (const handle of pending) {
      const stat = stats.get(handle.path);
      if (stat === undefined) throw new Error(`validated stat missing for '${handle.path}'`);
      const contents = new Uint8Array(stat.size);
      for (let offset = 0; offset < stat.size; offset += CHUNK_SIZE) {
        const length = Math.min(CHUNK_SIZE, stat.size - offset);
        const chunk = this.readRange(handle.path, offset, length);
        if (chunk.length !== length) {
          throw Object.assign(new Error(`EIO: short read for '${handle.path}' at ${offset}`), {
            code: "EIO",
          });
        }
        contents.set(chunk, offset);
      }
      const after = this.stat(handle.path);
      if (
        after?.type !== "file" ||
        after.ino !== handle.ino ||
        after.size !== stat.size ||
        after.mtime !== handle.rev
      ) {
        throw Object.assign(new Error(`ESTALE: file handle is stale, '${handle.path}'`), {
          code: "ESTALE",
        });
      }
      files.set(handle.path, contents);
    }
    return { files, remaining };
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

function regexLiteral(character: string): string {
  return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function classLiteral(character: string): string {
  return character.replace(/[\\\]\-^]/g, "\\$&");
}

function classMatcher(pattern: string, start: number): { source: string; end: number } | null {
  let index = start;
  let inverted = false;
  if (pattern[index] === "^") {
    inverted = true;
    index++;
  }

  const singles: string[] = [];
  const ranges: string[] = [];
  let prior: string | undefined;
  if (pattern[index] === "]") {
    singles.push(classLiteral("]"));
    index++;
  }

  while (index < pattern.length && pattern[index] !== "]") {
    const character = pattern[index];
    if (character === undefined) break;
    const upper = pattern[index + 1];
    if (character === "-" && prior !== undefined && upper !== undefined && upper !== "]") {
      const lowerCodePoint = prior.codePointAt(0);
      const upperCodePoint = upper.codePointAt(0);
      if (
        lowerCodePoint !== undefined &&
        upperCodePoint !== undefined &&
        lowerCodePoint <= upperCodePoint
      ) {
        ranges.push(`${classLiteral(prior)}-${classLiteral(upper)}`);
      }
      prior = undefined;
      index += 2;
      continue;
    }
    singles.push(classLiteral(character));
    prior = character;
    index++;
  }

  if (pattern[index] !== "]") return null;
  return {
    source: `[${inverted ? "^" : ""}${singles.join("")}${ranges.join("")}]`,
    end: index,
  };
}

function globMatcher(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") source += "[^]*";
    else if (character === "?") source += "[^]";
    else if (character === "[") {
      const matcher = classMatcher(pattern, index + 1);
      if (matcher === null) return /(?!)/u;
      source += matcher.source;
      index = matcher.end;
    } else if (character !== undefined) source += regexLiteral(character);
  }
  return new RegExp(`${source}$`, "u");
}
