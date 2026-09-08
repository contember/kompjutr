import { lstatSync, mkdirSync, readlinkSync, type Stats } from "node:fs";

import type {
  Dirent,
  DiscoverFilesOptions,
  DiscoverFilesPage,
  GitDrive,
  OrderedScanOptions,
  ReadBatch,
  ReadOptions,
  RealPath,
  RegularFileHandle,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  Stat,
  WriteEntry,
  WriteOptions,
} from "@kompjutr/drive";
import { errorCode, localError, normalizeHostError } from "../errors.js";
import { comparePaths, PathMapper, requireCanonicalAbsolutePath } from "../paths.js";
import type { RecoveryCoordinator } from "../recovery/coordinator.js";
import type { ObservationClock } from "../sqlite/observations.js";
import { DirectorySorter, type SortedTraversalEvent } from "./external-sort.js";
import {
  readFileAt,
  readFileStreamAt,
  readFilesAt,
  readHandlesAt,
  readRangeAt,
  statAt,
} from "./read.js";
import { DiskWriter } from "./write.js";

const DISCOVERY_PAGE_MAX = 1_000;
const IN_MEMORY_FRONTIER_LEVELS = 2;
const linkDecoder = new TextDecoder("utf-8", { fatal: true });

function realPath(path: string): RealPath;
function realPath(path: string): string {
  return path;
}

function joinVirtual(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function subtreeSuccessor(path: string): string {
  return path === "/" ? "0" : `${path}0`;
}

function regexEscape(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globRegex(pattern: string): RegExp {
  if (!pattern.isWellFormed() || pattern.includes("\0"))
    throw localError("EINVAL", "glob pattern is invalid");
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += regexEscape(character ?? "");
  }
  return new RegExp(`${source}$`, "u");
}

interface TraversalFrame {
  readonly virtual: string;
  readonly iterator: Iterator<SortedTraversalEvent>;
}

export interface DiskDriveOptions {
  readonly root: string;
  readonly spillDirectory: string;
  readonly mutationScope: object;
  readonly observations: ObservationClock;
  readonly recovery: RecoveryCoordinator;
}

export class DiskDrive implements GitDrive {
  readonly mutationScope: object;
  readonly #mapper: PathMapper;
  readonly #observations: ObservationClock;
  readonly #recovery: RecoveryCoordinator;
  readonly #sorter: DirectorySorter;
  readonly #writer: DiskWriter;
  #closed = false;

  constructor(options: DiskDriveOptions) {
    this.mutationScope = options.mutationScope;
    this.#mapper = new PathMapper(options.root);
    this.#observations = options.observations;
    this.#recovery = options.recovery;
    requireCanonicalAbsolutePath(options.spillDirectory, "spillDirectory");
    try {
      mkdirSync(options.spillDirectory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (!lstatSync(options.spillDirectory).isDirectory()) {
      throw localError("ENOTDIR", "spill path is not a directory", options.spillDirectory);
    }
    this.#sorter = new DirectorySorter(options.spillDirectory);
    this.#writer = new DiskWriter(this.#mapper, this.#recovery);
  }

  get root(): string {
    return this.#mapper.root;
  }

  #open(): void {
    if (this.#closed) throw localError("EBADF", "disk drive is closed");
  }

  #mutate<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      this.#recovery.operationFailed();
      throw error;
    }
  }

  stat(path: string) {
    this.#open();
    const canonical = this.#mapper.resolve(path, false);
    return statAt(this.#mapper.lexicalHost(canonical), this.#observations.next());
  }

  realpath(path: string): RealPath {
    this.#open();
    return this.#mapper.resolve(path, true);
  }

  readFile(path: string): Uint8Array {
    this.#open();
    return readFileAt(this.#mapper, path);
  }

  readRange(path: string, offset: number, length: number): Uint8Array {
    this.#open();
    return readRangeAt(this.#mapper, path, offset, length);
  }

  readFileStream(path: string, expected: Stat): Iterable<Uint8Array> {
    this.#open();
    return readFileStreamAt(this.#mapper, path, expected);
  }

  readlink(path: string): string {
    this.#open();
    const canonical = this.#mapper.resolve(path, false);
    let bytes: Buffer;
    try {
      bytes = readlinkSync(this.#mapper.lexicalHost(canonical), { encoding: "buffer" });
    } catch (error) {
      normalizeHostError(error, "read symbolic link", path);
    }
    try {
      return linkDecoder.decode(bytes);
    } catch {
      throw localError("EILSEQ", "symbolic link target is not valid UTF-8", path);
    }
  }

  readdir(path: string): Dirent[] {
    this.#open();
    const canonical = this.#mapper.resolve(path, true);
    const host = this.#mapper.lexicalHost(canonical);
    return [...this.#sorter.entries(host)].map((entry) => ({ name: entry.name, type: entry.type }));
  }

  *scanStream(root: string, options: OrderedScanOptions = {}): Generator<ScanEntry> {
    this.#open();
    const canonicalRoot = this.#mapper.resolve(root, true);
    const rootHost = this.#mapper.lexicalHost(canonicalRoot);
    let rootStat: Stats;
    try {
      rootStat = lstatSync(rootHost);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      normalizeHostError(error, "scan root", root);
    }
    if (!rootStat.isDirectory()) return;
    const revision = this.#observations.next();
    const stack: TraversalFrame[] = [
      {
        virtual: canonicalRoot,
        iterator: this.#sorter.traversal(rootHost, options.filesOnly === true)[Symbol.iterator](),
      },
    ];
    try {
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame === undefined) break;
        const step = frame.iterator.next();
        if (step.done === true) {
          stack.pop();
          continue;
        }
        const path = joinVirtual(frame.virtual, step.value.name);
        const host = this.#mapper.lexicalHost(path);
        const stat = statAt(host, revision);
        if (stat === null) continue;
        if (step.value.descend) {
          if (stat.type !== "dir") {
            if (options.filesOnly === true) yield { path, ...stat };
            continue;
          }
          if (options.pruneDirectory?.(path) === true) continue;
          const forceSpill = stack.length >= IN_MEMORY_FRONTIER_LEVELS;
          stack.push({
            virtual: path,
            iterator: this.#sorter
              .traversal(host, options.filesOnly === true, forceSpill)
              [Symbol.iterator](),
          });
          continue;
        }
        const entry: ScanEntry = { path, ...stat };
        if (entry.type !== "dir" || options.filesOnly !== true) yield entry;
      }
    } finally {
      for (const frame of stack) frame.iterator.return?.();
    }
  }

  scan(root: string, options: ScanOptions): ScanEntry[] {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw localError("EINVAL", "scan limit must be a positive safe integer");
    }
    const afterSubtree =
      options.afterSubtree === undefined ? undefined : subtreeSuccessor(options.afterSubtree);
    const entries: ScanEntry[] = [];
    for (const entry of this.scanStream(root, { filesOnly: options.filesOnly })) {
      if (options.after !== undefined && comparePaths(entry.path, options.after) <= 0) continue;
      if (afterSubtree !== undefined && comparePaths(entry.path, afterSubtree) < 0) continue;
      entries.push(entry);
      if (entries.length === options.limit) break;
    }
    return entries;
  }

  discoverFiles(
    root: RealPath,
    pattern: string,
    options: DiscoverFilesOptions = {},
  ): DiscoverFilesPage {
    const limit = options.limit ?? DISCOVERY_PAGE_MAX;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > DISCOVERY_PAGE_MAX) {
      throw localError("EINVAL", `discoverFiles limit must be from 1 to ${DISCOVERY_PAGE_MAX}`);
    }
    const matches = globRegex(pattern);
    const excluded = (options.excludeRoots ?? []).map((path) => this.#mapper.resolve(path, true));
    const isExcluded = (path: string): boolean =>
      excluded.some((root) => path === root || path.startsWith(`${root}/`));
    if (isExcluded(root)) return { handles: [], next: null };
    const found: RegularFileHandle[] = [];
    for (const entry of this.scanStream(root, {
      filesOnly: true,
      pruneDirectory: isExcluded,
    })) {
      if (options.after !== undefined && comparePaths(entry.path, options.after) <= 0) continue;
      if (isExcluded(entry.path)) continue;
      if (!matches.test(entry.path)) continue;
      found.push({ path: realPath(entry.path), ino: entry.ino, size: entry.size, rev: entry.rev });
      if (found.length > limit) break;
    }
    const handles = found.slice(0, limit);
    return {
      handles,
      next: found.length > limit ? (handles[handles.length - 1]?.path ?? null) : null,
    };
  }

  readFileHandles(handles: readonly RegularFileHandle[], options?: { budget?: number }) {
    this.#open();
    return readHandlesAt(this.#mapper, handles, options);
  }

  readFiles(paths: readonly string[], options?: ReadOptions): ReadBatch {
    this.#open();
    return readFilesAt(this.#mapper, paths, options);
  }

  glob(root: string, pattern: string, options: { limit?: number } = {}): string[] {
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw localError("EINVAL", "glob limit must be positive");
    const matches = globRegex(pattern);
    const paths: string[] = [];
    for (const entry of this.scanStream(root)) {
      if (!matches.test(entry.path)) continue;
      paths.push(entry.path);
      if (paths.length === limit) break;
    }
    return paths;
  }

  writeFile(
    path: string,
    bytes: Uint8Array,
    options: { mode?: number; contentId?: Uint8Array } = {},
  ): void {
    this.#open();
    this.#mutate(() => this.#writer.writeFile(path, bytes, options.mode));
  }

  createFile(path: string, mode: number): void {
    this.#open();
    this.#mutate(() => this.#writer.writeFile(path, new Uint8Array(), mode, true));
  }

  writeRange(path: string, bytes: Uint8Array, offset: number): void {
    this.#open();
    this.#mutate(() => this.#writer.writeRange(path, bytes, offset));
  }

  symlink(target: string, path: string): void {
    this.#open();
    this.#mutate(() => this.#writer.symlink(target, path));
  }

  unlink(path: string): void {
    this.#open();
    this.#mutate(() => {
      const stat = this.stat(path);
      if (stat === null) throw localError("ENOENT", "path does not exist", path);
      if (stat.type === "dir") throw localError("EISDIR", "cannot unlink a directory", path);
      this.#writer.remove([path], false, false);
    });
  }

  rmdir(path: string): void {
    this.#open();
    this.#mutate(() => {
      const stat = this.stat(path);
      if (stat === null) throw localError("ENOENT", "path does not exist", path);
      if (stat.type !== "dir") throw localError("ENOTDIR", "path is not a directory", path);
      this.#writer.remove([path], false, false);
    });
  }

  chmod(path: string, mode: number): void {
    this.#open();
    this.#mutate(() => this.#writer.chmod(path, mode));
  }

  writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void {
    this.#open();
    this.#mutate(() => this.#writer.writeFiles(entries, options));
  }

  makeDirectories(paths: readonly string[]): void {
    this.#open();
    this.#mutate(() => this.#writer.makeDirectories(paths));
  }

  removeFiles(paths: readonly string[], options: RemoveOptions = {}): void {
    this.#open();
    this.#mutate(() =>
      this.#writer.remove(paths, options.recursive === true, options.force === true),
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#sorter.close();
    this.#closed = true;
  }
}
