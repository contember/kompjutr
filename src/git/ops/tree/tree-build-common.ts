import { CorruptError, GitError } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";

export function checkedBytes(total: number, bytes: number, label: string): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > Number.MAX_SAFE_INTEGER - total) {
    throw new GitError("E2BIG", `tree-build ${label} size overflows`);
  }
  return total + bytes;
}

export function requireLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`invalid tree-build ${label} limit`);
  }
  return value;
}

export function utf8Length(value: string, label: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) throw new CorruptError(`${label} is not canonical UTF-16`);
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CorruptError(`${label} is not canonical UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", `${label} size overflows`);
  }
  return bytes;
}

export function serializedEntryBytes(modeBytes: number, nameBytes: number): number {
  // `<mode> <name>\0<20-byte oid>`.
  return modeBytes + nameBytes + 22;
}

export function serializedLeafModeBytes(mode: number): number {
  if (mode !== 0o100644 && mode !== 0o100755 && mode !== 0o120000 && mode !== 0o160000) {
    throw new CorruptError("tree-build index mode is invalid");
  }
  return 6;
}

export function validOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

export function pathDepth(path: string): number {
  if (path === "") return 0;
  let depth = 1;
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === 0x2f) depth++;
  }
  return depth;
}

export function expectedDirectoryPaths(paths: readonly { path: string }[]): string[] {
  const expected = new Set<string>([""]);
  for (const row of paths) {
    const path = row.path;
    let slash = path.indexOf("/");
    while (slash >= 0) {
      expected.add(path.slice(0, slash));
      slash = path.indexOf("/", slash + 1);
    }
  }
  return [...expected].sort(comparePaths);
}

export function validatePathShape(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.endsWith("/")) {
    throw new CorruptError("tree-build index path is invalid");
  }
  let start = 0;
  for (let index = 0; index <= path.length; index++) {
    if (index < path.length && path.charCodeAt(index) !== 0x2f) {
      if (path.charCodeAt(index) === 0) {
        throw new CorruptError("tree-build index path is invalid");
      }
      continue;
    }
    const length = index - start;
    if (
      length === 0 ||
      (length === 1 && path.charCodeAt(start) === 0x2e) ||
      (length === 2 && path.charCodeAt(start) === 0x2e && path.charCodeAt(start + 1) === 0x2e)
    ) {
      throw new CorruptError("tree-build index path is invalid");
    }
    start = index + 1;
  }
}

export function validatePath(path: string): string[] {
  validatePathShape(path);
  const segments = path.split("/");
  return segments;
}
