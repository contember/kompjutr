import { normalize } from "../path.js";
import type { Dirent, ScanEntry, Stat } from "../types.js";
import { filesystemError } from "./errors.js";
import type { NodeDirent, NodeStats, ParsedFlags, TimeLike, WalkEntry } from "./node-types.js";

export function wrapStats(stat: Stat): NodeStats {
  const time = new Date(stat.mtime);
  return {
    dev: 0,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 4096,
    ino: stat.ino,
    size: stat.size,
    blocks: Math.ceil(stat.size / 512),
    atimeMs: stat.mtime,
    mtimeMs: stat.mtime,
    ctimeMs: stat.mtime,
    birthtimeMs: stat.mtime,
    atime: time,
    mtime: time,
    ctime: time,
    birthtime: time,
    isFile: () => stat.type === "file",
    isDirectory: () => stat.type === "dir",
    isSymbolicLink: () => stat.type === "symlink",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

export function wrapDirent(parentPath: string, entry: Dirent): NodeDirent {
  const parent = normalize(parentPath);
  return {
    name: entry.name,
    parentPath: parent,
    path: parent === "/" ? `/${entry.name}` : `${parent}/${entry.name}`,
    isFile: () => entry.type === "file",
    isDirectory: () => entry.type === "dir",
    isSymbolicLink: () => entry.type === "symlink",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

export function parseFlags(flags: string): ParsedFlags {
  switch (flags) {
    case "r":
      return {
        read: true,
        write: false,
        create: false,
        truncate: false,
        append: false,
        exclusive: false,
      };
    case "r+":
      return {
        read: true,
        write: true,
        create: false,
        truncate: false,
        append: false,
        exclusive: false,
      };
    case "w":
      return {
        read: false,
        write: true,
        create: true,
        truncate: true,
        append: false,
        exclusive: false,
      };
    case "w+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: true,
        append: false,
        exclusive: false,
      };
    case "wx":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: false,
        exclusive: true,
      };
    case "wx+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: false,
        exclusive: true,
      };
    case "a":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: false,
      };
    case "a+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: false,
      };
    case "ax":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: true,
      };
    case "ax+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: true,
      };
    default:
      throw filesystemError("EINVAL", "open", undefined, `unsupported flag ${flags}`);
  }
}

export function checkBufferRange(
  buffer: Uint8Array,
  offset: number,
  length: number,
  syscall: string,
): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.byteLength
  ) {
    throw filesystemError("EINVAL", syscall, undefined, "invalid buffer range");
  }
}

export function checkPosition(position: number, syscall: string): void {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw filesystemError("EINVAL", syscall, undefined, "invalid position");
  }
}

export function countOption(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`walk ${name} must be a non-negative safe integer`);
  return value;
}

export function timeMilliseconds(value: TimeLike, syscall: string): number {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value) * 1_000;
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(Math.trunc(milliseconds))) {
    throw filesystemError("EINVAL", syscall, undefined, "invalid time");
  }
  return Math.trunc(milliseconds);
}

export function pathDepth(path: string): number {
  if (path === "/") return 0;
  return path.split("/").length - 1;
}

export function isExcluded(
  path: string,
  root: string,
  excluded: ReadonlySet<string>,
  excludeHidden = false,
): boolean {
  const relative = root === "/" ? path.slice(1) : path.slice(root.length + 1);
  for (const segment of relative.split("/")) {
    if (excluded.has(segment) || (excludeHidden && segment.startsWith("."))) return true;
  }
  return false;
}

export function toWalkEntry(entry: ScanEntry): WalkEntry {
  return {
    path: entry.path,
    type: entry.type,
    mode: entry.mode & 0o7777,
    mtime: entry.mtime,
    size: entry.size,
    ...(entry.target === null ? {} : { linkTarget: entry.target }),
  };
}
