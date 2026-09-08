import { randomUUID } from "node:crypto";
import {
  closeSync,
  type Dir,
  type Dirent,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import type { EntryType } from "@kompjutr/drive";
import { errorCode, localError, normalizeHostError } from "../errors.js";
import { comparePaths } from "../paths.js";

const NAME_BATCH = 1_024;
const MERGE_FAN_IN = 32;
const MAX_RUN_RECORD_BYTES = 8 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export interface SortedDirectoryEntry {
  readonly name: string;
  readonly type: EntryType;
}

export interface SortedTraversalEvent extends SortedDirectoryEntry {
  readonly descend: boolean;
}

type SortMode = "entries" | "files" | "structural";

function sortKey(entry: SortedTraversalEvent): string {
  return entry.descend ? `${entry.name}/` : entry.name;
}

function compareEntries(left: SortedTraversalEvent, right: SortedTraversalEvent): number {
  return comparePaths(sortKey(left), sortKey(right));
}

function decodeName(entry: Dirent): string {
  const value: unknown = Reflect.get(entry, "name");
  if (!(value instanceof Uint8Array))
    throw localError("EIO", "directory stream did not return byte names");
  try {
    return decoder.decode(value);
  } catch {
    throw localError("EILSEQ", "directory entry name is not valid UTF-8");
  }
}

export interface DirectoryEntryTypeProbe {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

function directEntryType(entry: DirectoryEntryTypeProbe): EntryType | "special" | "unknown" {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()) {
    return "special";
  }
  return "unknown";
}

export function classifyDirectoryEntry(
  entry: DirectoryEntryTypeProbe,
  hostPath: string,
): EntryType | null {
  const direct = directEntryType(entry);
  if (direct === "special") return null;
  if (direct !== "unknown") return direct;
  let stat: Stats;
  try {
    stat = lstatSync(hostPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    normalizeHostError(error, "inspect directory entry", hostPath);
  }
  if (stat.isDirectory()) return "dir";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return null;
}

function openByteDirectory(path: string): Dir {
  try {
    return Reflect.apply(opendirSync, undefined, [path, { encoding: "buffer", bufferSize: 32 }]);
  } catch (error) {
    normalizeHostError(error, "open directory", path);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written === 0) throw localError("EIO", "temporary sort write made no progress");
    offset += written;
  }
}

function encodedEntry(entry: SortedTraversalEvent): Uint8Array {
  const payload = encoder.encode(JSON.stringify(entry));
  if (payload.length > MAX_RUN_RECORD_BYTES)
    throw localError("ENAMETOOLONG", "directory entry is too large");
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, false);
  frame.set(payload, 4);
  return frame;
}

function decodeEntry(payload: Uint8Array): SortedTraversalEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payload));
  } catch {
    throw localError("EIO", "temporary directory-sort record is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw localError("EIO", "temporary directory-sort record is not an object");
  }
  const name: unknown = Reflect.get(parsed, "name");
  const type: unknown = Reflect.get(parsed, "type");
  const descend: unknown = Reflect.get(parsed, "descend");
  if (
    typeof name !== "string" ||
    name === "" ||
    name.includes("/") ||
    name.includes("\0") ||
    !name.isWellFormed() ||
    (type !== "file" && type !== "dir" && type !== "symlink") ||
    typeof descend !== "boolean" ||
    (descend && type !== "dir")
  ) {
    throw localError("EIO", "temporary directory-sort record has invalid fields");
  }
  return { name, type, descend };
}

function readExactly(fd: number, bytes: Uint8Array, position: number): boolean {
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, position + offset);
    if (count === 0) return false;
    offset += count;
  }
  return true;
}

class RunCursor {
  readonly #path: string;
  #position = 0;
  #done = false;

  constructor(path: string) {
    this.#path = path;
  }

  next(): SortedTraversalEvent | null {
    if (this.#done) return null;
    const fd = openSync(this.#path, "r");
    try {
      const header = new Uint8Array(4);
      if (!readExactly(fd, header, this.#position)) {
        this.#done = true;
        return null;
      }
      this.#position += 4;
      const length = new DataView(header.buffer).getUint32(0, false);
      if (length > MAX_RUN_RECORD_BYTES)
        throw localError("EIO", "temporary sort record is too large");
      const payload = new Uint8Array(length);
      if (!readExactly(fd, payload, this.#position)) {
        throw localError("EIO", "temporary sort record is truncated");
      }
      this.#position += length;
      return decodeEntry(payload);
    } finally {
      closeSync(fd);
    }
  }
}

interface HeapItem {
  readonly entry: SortedTraversalEvent;
  readonly cursor: RunCursor;
}

class MergeHeap {
  readonly #items: HeapItem[] = [];

  push(item: HeapItem): void {
    this.#items.push(item);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentItem = this.#items[parent];
      if (parentItem === undefined || compareEntries(parentItem.entry, item.entry) <= 0) break;
      this.#items[index] = parentItem;
      index = parent;
    }
    this.#items[index] = item;
  }

  pop(): HeapItem | null {
    const first = this.#items[0];
    const last = this.#items.pop();
    if (first === undefined || last === undefined) return null;
    if (this.#items.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.#items.length) break;
      const right = left + 1;
      const leftItem = this.#items[left];
      const rightItem = this.#items[right];
      if (leftItem === undefined) break;
      const child =
        rightItem !== undefined && compareEntries(rightItem.entry, leftItem.entry) < 0
          ? right
          : left;
      const childItem = this.#items[child];
      if (childItem === undefined || compareEntries(last.entry, childItem.entry) <= 0) break;
      this.#items[index] = childItem;
      index = child;
    }
    this.#items[index] = last;
    return first;
  }
}

export class DirectorySorter {
  readonly #spillRoot: string;
  #closed = false;

  constructor(spillRoot: string) {
    this.#spillRoot = spillRoot;
    if (!lstatSync(spillRoot).isDirectory()) {
      throw localError("ENOTDIR", "spill path is not a directory", spillRoot);
    }
    this.cleanup();
  }

  cleanup(): void {
    const directory = openByteDirectory(this.#spillRoot);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) return;
        const name = decodeName(entry);
        if (!name.startsWith("sort-") && !name.startsWith("run-")) {
          throw localError("EIO", `unexpected spill entry: ${name}`);
        }
        rmSync(join(this.#spillRoot, name), { force: true, recursive: true });
      }
    } finally {
      directory.closeSync();
    }
  }

  *entries(hostDirectory: string, forceSpill = false): Generator<SortedDirectoryEntry> {
    for (const event of this.#sorted(hostDirectory, "entries", forceSpill)) {
      yield { name: event.name, type: event.type };
    }
  }

  *traversal(
    hostDirectory: string,
    filesOnly: boolean,
    forceSpill = false,
  ): Generator<SortedTraversalEvent> {
    yield* this.#sorted(hostDirectory, filesOnly ? "files" : "structural", forceSpill);
  }

  *#sorted(
    hostDirectory: string,
    mode: SortMode,
    forceSpill: boolean,
  ): Generator<SortedTraversalEvent> {
    if (this.#closed) throw localError("EBADF", "directory sorter is closed");
    const batch: SortedTraversalEvent[] = [];
    const operation = join(this.#spillRoot, `sort-${randomUUID()}`);
    let initialRuns = 0;
    try {
      const directory = openByteDirectory(hostDirectory);
      try {
        for (;;) {
          const raw = directory.readSync();
          if (raw === null) break;
          const direct = directEntryType(raw);
          if (direct === "special") continue;
          const name = decodeName(raw);
          const type =
            direct === "unknown" ? classifyDirectoryEntry(raw, join(hostDirectory, name)) : direct;
          if (type === null) continue;
          if (type === "dir" && mode === "structural") {
            batch.push({ name, type, descend: false });
          }
          batch.push({ name, type, descend: type === "dir" && mode !== "entries" });
          if (batch.length >= NAME_BATCH) {
            if (initialRuns === 0) mkdirSync(operation, 0o700);
            this.#spill(batch, this.#runPath(operation, 0, initialRuns));
            initialRuns++;
          }
        }
      } finally {
        directory.closeSync();
      }

      if (initialRuns === 0 && batch.length === 0) return;
      if (initialRuns === 0 && !forceSpill) {
        batch.sort(compareEntries);
        yield* batch;
        return;
      }
      if (batch.length > 0) {
        if (initialRuns === 0) mkdirSync(operation, 0o700);
        this.#spill(batch, this.#runPath(operation, 0, initialRuns));
        initialRuns++;
      }
      let level = 0;
      let runCount = initialRuns;
      while (runCount > 1) {
        let nextCount = 0;
        for (let offset = 0; offset < runCount; offset += MERGE_FAN_IN) {
          const inputs: string[] = [];
          const end = Math.min(offset + MERGE_FAN_IN, runCount);
          for (let index = offset; index < end; index++) {
            inputs.push(this.#runPath(operation, level, index));
          }
          this.#merge(inputs, this.#runPath(operation, level + 1, nextCount));
          nextCount++;
        }
        level++;
        runCount = nextCount;
      }
      const final = this.#runPath(operation, level, 0);
      const cursor = new RunCursor(final);
      for (;;) {
        const entry = cursor.next();
        if (entry === null) break;
        yield entry;
      }
    } finally {
      rmSync(operation, { force: true, recursive: true });
    }
  }

  #runPath(operation: string, level: number, index: number): string {
    return join(operation, `run-${level}-${index}`);
  }

  #spill(batch: SortedTraversalEvent[], path: string): void {
    batch.sort(compareEntries);
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
      for (const entry of batch) writeAll(fd, encodedEntry(entry));
      batch.splice(0, batch.length);
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  #merge(inputs: readonly string[], output: string): void {
    let fd: number | undefined;
    const heap = new MergeHeap();
    try {
      fd = openSync(output, "wx", 0o600);
      for (const input of inputs) {
        const cursor = new RunCursor(input);
        const entry = cursor.next();
        if (entry !== null) heap.push({ entry, cursor });
      }
      for (;;) {
        const item = heap.pop();
        if (item === null) break;
        writeAll(fd, encodedEntry(item.entry));
        const next = item.cursor.next();
        if (next !== null) heap.push({ entry: next, cursor: item.cursor });
      }
    } catch (error) {
      rmSync(output, { force: true });
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    for (const input of inputs) rmSync(input, { force: true });
  }

  close(): void {
    if (this.#closed) return;
    this.cleanup();
    this.#closed = true;
  }
}
