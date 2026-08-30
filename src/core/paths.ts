/** Git-side path helpers. Everything here is POSIX-shaped, like the workspace. */

export { comparePaths } from "./streams.js";

export function normalizePath(path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

export function joinPath(root: string, relative: string): string {
  if (relative === "" || relative === ".") return normalizePath(root);
  return normalizePath(`${root.replace(/\/+$/, "")}/${relative}`);
}

export function splitPath(path: string): string[] {
  return normalizePath(path)
    .split("/")
    .filter((segment) => segment !== "");
}

/** `path` relative to `root`, or null when it falls outside. */
export function relativeTo(root: string, path: string): string | null {
  const base = normalizePath(root);
  const target = normalizePath(path);
  if (target === base) return "";
  const prefix = base === "/" ? "/" : `${base}/`;
  if (!target.startsWith(prefix)) return null;
  return target.slice(prefix.length);
}

export function dirnameOf(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export function basenameOf(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function ancestorsOf(path: string): string[] {
  const ancestors: string[] = [];
  let ancestor = dirnameOf(path);
  while (ancestor !== "/") {
    ancestors.push(ancestor);
    ancestor = dirnameOf(ancestor);
  }
  ancestors.push("/");
  return ancestors;
}

export function isPathRoot(root: string, path: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (normalizedRoot === "/") return normalizedPath.startsWith("/");
  return (
    normalizedPath === normalizedRoot ||
    (normalizedPath.startsWith(normalizedRoot) &&
      normalizedPath.charCodeAt(normalizedRoot.length) === 0x2f)
  );
}

export function isNestedPath(root: string, path: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  return normalizedPath !== normalizedRoot && isPathRoot(normalizedRoot, normalizedPath);
}

export function isCanonicalAbsolutePath(path: string): boolean {
  if (path.length < 2 || path.charCodeAt(0) !== 0x2f || path.charCodeAt(path.length - 1) === 0x2f) {
    return false;
  }
  return isCanonicalPathSegments(path, 1);
}

export function isCanonicalGitPath(path: string): boolean {
  if (path === "" || path.charCodeAt(0) === 0x2f || path.charCodeAt(path.length - 1) === 0x2f) {
    return false;
  }
  return isCanonicalPathSegments(path, 0);
}

function isCanonicalPathSegments(path: string, firstSegment: number): boolean {
  let segmentStart = firstSegment;
  for (let index = firstSegment; index <= path.length; index++) {
    const unit = path.charCodeAt(index);
    if (index === path.length || unit === 0x2f) {
      const length = index - segmentStart;
      if (
        length === 0 ||
        (length === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
        (length === 2 &&
          path.charCodeAt(segmentStart) === 0x2e &&
          path.charCodeAt(segmentStart + 1) === 0x2e)
      ) {
        return false;
      }
      segmentStart = index + 1;
      continue;
    }
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = path.charCodeAt(++index);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
