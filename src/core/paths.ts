/** Absolute-path helpers. Everything here is POSIX-shaped, like the workspace. */

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
