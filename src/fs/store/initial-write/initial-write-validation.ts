import { filesystemError } from "../../errors.js";

export const MAX_PATH_SEGMENTS = 128;

export function utf8Length(value: string): number {
  let total = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) total++;
    else if (unit < 0x800) total += 2;
    else if (unit >= 0xd800 && unit < 0xdc00) {
      total += 4;
      index++;
    } else total += 3;
  }
  return total;
}

export function jsonStringCodeUnits(value: string | null, end = value?.length ?? 0): number {
  if (value === null) return 4;
  let total = 2;
  for (let index = 0; index < end; index++) {
    const unit = value.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
    ) {
      total += 2;
    } else if (
      unit < 0x20 ||
      (unit >= 0xd800 &&
        unit <= 0xdfff &&
        !(
          unit <= 0xdbff &&
          index + 1 < end &&
          value.charCodeAt(index + 1) >= 0xdc00 &&
          value.charCodeAt(index + 1) <= 0xdfff
        ))
    ) {
      total += 6;
    } else {
      total++;
      if (unit >= 0xd800 && unit <= 0xdbff) {
        total++;
        index++;
      }
    }
  }
  return total;
}

function invalidSegment(path: string, start: number, end: number): boolean {
  return (
    start === end ||
    (end - start === 1 && path.charCodeAt(start) === 0x2e) ||
    (end - start === 2 && path.charCodeAt(start) === 0x2e && path.charCodeAt(start + 1) === 0x2e)
  );
}

/** Validate without split/slice/normalise allocations. */
export function validateCanonicalRoot(root: string): number {
  if (root === "/") return 0;
  if (root.length < 2 || root.charCodeAt(0) !== 0x2f || root.charCodeAt(root.length - 1) === 0x2f) {
    throw filesystemError("EINVAL", "initial worktree root is not canonical", root);
  }
  let segments = 0;
  let start = 1;
  for (let index = 1; index <= root.length; index++) {
    const unit = index === root.length ? 0x2f : root.charCodeAt(index);
    if (unit === 0) throw filesystemError("EINVAL", "initial worktree root is not canonical", root);
    if (unit !== 0x2f) continue;
    segments++;
    if (segments > MAX_PATH_SEGMENTS) {
      throw filesystemError("E2BIG", "initial worktree root exceeds the path limit", root);
    }
    if (invalidSegment(root, start, index)) {
      throw filesystemError("EINVAL", "initial worktree root is not canonical", root);
    }
    start = index + 1;
  }
  return segments;
}

export function rootAncestors(root: string): string[] {
  const ancestors = ["/"];
  if (root === "/") return ancestors;
  let slash = root.indexOf("/", 1);
  while (slash > 0) {
    ancestors.push(root.slice(0, slash));
    slash = root.indexOf("/", slash + 1);
  }
  ancestors.push(root);
  return ancestors;
}

/** Validate without allocating segment strings or an array. */
export function validateRelative(path: string): number {
  if (
    path.length === 0 ||
    path.charCodeAt(0) === 0x2f ||
    path.charCodeAt(path.length - 1) === 0x2f
  ) {
    throw filesystemError("EINVAL", "initial worktree path escapes or is not canonical", path);
  }
  let segments = 0;
  let start = 0;
  for (let index = 0; index <= path.length; index++) {
    const unit = index === path.length ? 0x2f : path.charCodeAt(index);
    if (unit === 0) {
      throw filesystemError("EINVAL", "initial worktree path escapes or is not canonical", path);
    }
    if (unit !== 0x2f) continue;
    segments++;
    if (segments > MAX_PATH_SEGMENTS) {
      throw filesystemError("E2BIG", "initial worktree path exceeds the path limit", path);
    }
    if (invalidSegment(path, start, index)) {
      throw filesystemError("EINVAL", "initial worktree path escapes or is not canonical", path);
    }
    start = index + 1;
  }
  return segments;
}

export function checkedMode(mode: number | undefined, fallback: number, path: string): number {
  if (mode === undefined) return fallback;
  if (!Number.isSafeInteger(mode) || mode < 0) {
    throw filesystemError("EINVAL", "initial worktree mode is invalid", path);
  }
  return mode & 0o7777;
}

export function checkedSize(size: number, path: string): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw filesystemError("EINVAL", "initial worktree file size is invalid", path);
  }
  return size;
}

export function checkedContentId(
  contentId: Uint8Array | undefined,
  path: string,
): Uint8Array | null {
  if (contentId === undefined) return null;
  if (!(contentId instanceof Uint8Array)) {
    throw filesystemError("EINVAL", "initial worktree content id is invalid", path);
  }
  return contentId;
}

export function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof Reflect.get(value, "then") === "function";
}
